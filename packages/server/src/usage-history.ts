import type { StatusPayload } from '@stim-cli/core/state';
import type { DeviceUsageSeries, UsageHistory, UsageSeries } from './protocol.ts';

const INTERVAL_MS = 10_000;
const POINTS = 60;

interface Reading {
  cpuPercent: number;
  memoryMb: number;
}

type Slots = Map<number, Reading>;

type DeviceMeta = Omit<DeviceUsageSeries, keyof UsageSeries>;

/**
 * Per-environment and per-device CPU and memory from the status payloads stim-server receives, in 10-second slots
 * over the last 10 minutes. A later payload in the same slot replaces the earlier one. An environment sums every
 * machine owner of its workspace; a device is a simulator or emulator owner, keyed by its UDID or AVD name.
 */
export class UsageRecorder {
  private readonly environments = new Map<string, Slots>();
  private readonly devices = new Map<string, { meta: DeviceMeta; slots: Slots }>();

  record(payload: StatusPayload, at: number = Date.now()): void {
    const owners = payload?.machine?.owners;
    if (!Array.isArray(owners)) return;
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
      }
    }
    for (const [workspace, reading] of sums) {
      this.environments.set(workspace, (this.environments.get(workspace) ?? new Map()).set(slot, reading));
    }
    this.prune(slot);
  }

  /** The last 10 minutes ending at `now`'s slot, or null when no series has a reading in them. */
  history(now: number = Date.now()): UsageHistory | null {
    const end = Math.floor(now / INTERVAL_MS);
    this.prune(end);
    const series = (slots: Slots): UsageSeries => {
      const cpuPercent: (number | null)[] = [];
      const memoryMb: (number | null)[] = [];
      for (let slot = end - POINTS + 1; slot <= end; slot++) {
        const reading = slots.get(slot);
        cpuPercent.push(reading ? Math.round(reading.cpuPercent * 10) / 10 : null);
        memoryMb.push(reading ? Math.round(reading.memoryMb) : null);
      }
      return { cpuPercent, memoryMb };
    };
    const environments = [...this.environments].map(([workspace, slots]) =>
      Object.assign({ workspace }, series(slots)),
    );
    const devices = [...this.devices.values()].map(({ meta, slots }) => Object.assign({}, meta, series(slots)));
    if (!environments.length && !devices.length) return null;
    return { intervalMs: INTERVAL_MS, endAt: end * INTERVAL_MS, environments, devices };
  }

  private prune(slot: number): void {
    const trim = (slots: Slots) => {
      for (const at of slots.keys()) if (at <= slot - POINTS) slots.delete(at);
      return slots.size > 0;
    };
    for (const [key, slots] of this.environments) if (!trim(slots)) this.environments.delete(key);
    for (const [key, { slots }] of this.devices) if (!trim(slots)) this.devices.delete(key);
  }
}
