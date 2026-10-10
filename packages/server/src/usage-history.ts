import type { StatusPayload } from '@stim-cli/core/state';
import type { DeviceUsageSeries, UsageHistory, UsageSeries } from './protocol.ts';

const INTERVAL_MS = 15_000;
const POINTS = 40;

interface Reading {
  cpuPercent: number;
  memoryMb: number;
}

type Slots = Map<number, Reading>;

type DeviceMeta = Omit<DeviceUsageSeries, keyof UsageSeries>;

/**
 * Per-environment and per-device CPU and memory from the status payloads stim-server receives, in 15-second slots, the cadence at which `status --watch` rereads machine usage,
 * over the last 10 minutes. A later payload in the same slot replaces the earlier one. `status --watch` prints no line
 * when usage moved less than a step, so a slot with no payload repeats the series' previous reading while the series is in the latest payload. An environment sums every
 * machine owner of its workspace; a device is a simulator or emulator owner, keyed by its UDID or AVD name.
 */
export class UsageRecorder {
  private readonly environments = new Map<string, Slots>();
  private readonly devices = new Map<string, { meta: DeviceMeta; slots: Slots }>();
  private liveEnvironments = new Set<string>();
  private liveDevices = new Set<string>();

  record(payload: StatusPayload, at: number = Date.now()): void {
    const owners = payload?.machine?.owners;
    if (!Array.isArray(owners)) {
      this.liveEnvironments = new Set();
      this.liveDevices = new Set();
      return;
    }
    this.liveEnvironments = new Set();
    this.liveDevices = new Set();
    const slot = Math.floor(at / INTERVAL_MS);
    const sums = new Map<string, Reading>();
    for (const owner of owners) {
      const reading = { cpuPercent: owner.cpuPercent, memoryMb: owner.memoryMb };
      if (owner.workspace) {
        const sum = sums.get(owner.workspace) ?? { cpuPercent: 0, memoryMb: 0 };
        sums.set(owner.workspace, {
          cpuPercent: sum.cpuPercent + reading.cpuPercent,
          memoryMb: sum.memoryMb + reading.memoryMb,
        });
      }
      if ((owner.kind === 'simulator' || owner.kind === 'emulator') && owner.id) {
        const key = `${owner.kind}:${owner.id}`;
        const slots = this.devices.get(key)?.slots ?? new Map();
        const meta: DeviceMeta = {
          kind: owner.kind,
          id: owner.id,
          workspace: owner.workspace,
          ...(owner.slot ? { slot: owner.slot } : {}),
        };
        this.devices.set(key, { meta, slots: slots.set(slot, reading) });
        this.liveDevices.add(key);
      }
    }
    for (const [workspace, reading] of sums) {
      this.environments.set(workspace, (this.environments.get(workspace) ?? new Map()).set(slot, reading));
      this.liveEnvironments.add(workspace);
    }
    this.prune(slot);
  }

  /** The last 10 minutes ending at `now`'s slot, or null when no series has a reading in them. */
  history(now: number = Date.now()): UsageHistory | null {
    const end = Math.floor(now / INTERVAL_MS);
    this.prune(end);
    const series = (slots: Slots, live: boolean): UsageSeries => {
      const cpuPercent: (number | null)[] = [];
      const memoryMb: (number | null)[] = [];
      const start = end - POINTS + 1;
      const newest = Math.max(...slots.keys());
      let held = [...slots].filter(([at]) => at < start).toSorted(([a], [b]) => b - a)[0]?.[1];
      for (let slot = start; slot <= end; slot++) {
        held = slots.get(slot) ?? held;
        const reading = slots.get(slot) ?? (live || slot <= newest ? held : undefined);
        cpuPercent.push(reading ? Math.round(reading.cpuPercent * 10) / 10 : null);
        memoryMb.push(reading ? Math.round(reading.memoryMb) : null);
      }
      return { cpuPercent, memoryMb };
    };
    const environments = [...this.environments].map(([workspace, slots]) =>
      Object.assign({ workspace }, series(slots, this.liveEnvironments.has(workspace))),
    );
    const devices = [...this.devices].map(([key, { meta, slots }]) =>
      Object.assign({}, meta, series(slots, this.liveDevices.has(key))),
    );
    if (!environments.length && !devices.length) return null;
    return { intervalMs: INTERVAL_MS, endAt: end * INTERVAL_MS, environments, devices };
  }

  private prune(slot: number): void {
    const trim = (slots: Slots, live: boolean) => {
      const newest = Math.max(...slots.keys());
      for (const at of slots.keys()) if (at <= slot - POINTS && !(live && at === newest)) slots.delete(at);
      return slots.size > 0;
    };
    for (const [key, slots] of this.environments)
      if (!trim(slots, this.liveEnvironments.has(key))) this.environments.delete(key);
    for (const [key, { slots }] of this.devices) if (!trim(slots, this.liveDevices.has(key))) this.devices.delete(key);
  }
}
