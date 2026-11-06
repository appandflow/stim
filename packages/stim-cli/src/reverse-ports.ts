import { MAX_REVERSE_PORTS, hostedNativeRecords, reversePorts, REVERSE_PORTS_KEY } from '@stim-cli/core/state';
import type { StimContext } from '@stim-cli/core';
import { resolveOwnedAvdSerialAsync, removeMetroReverses } from './devices/android.ts';
import { projectDeviceSlots } from './devices/device-slots.ts';
import { forgetPhoneReverse, readPhoneReverseSerials, recordPhoneReverse } from './devices/phone-reverses.ts';
import { reverseMetroPorts } from './engine/app-install.ts';
import { leaseIsExpired, listLeaseFiles } from './engine/device-lease.ts';
import { readHostedNative } from './workspace/placement-state.ts';
import { requireReverseLinks, syncHostedReversesTo } from './device-host/reverse.ts';
import { getProject } from './workspace/config.ts';
import { readWorkspaceState, updateWorkspaceStateAsync } from './workspace/workspace-state.ts';

type ReverseStatus = 'reachable' | 'applied' | 'removed' | 'pending' | 'unsupported' | 'failed';

export interface ReverseDeviceReport {
  platform: 'ios' | 'android';
  device: string;
  status: ReverseStatus;
  detail: string;
}

export function resolveReversePort(root: string, target: string): number {
  const project = getProject(root);
  if (/^\d+$/.test(target)) {
    const port = Number(target);
    if (port < 1 || port > 65535) throw new Error(`${target} is not a TCP port (1-65535).`);
    if (port === project?.metroPort)
      throw new Error(`Port ${port} is this workspace's Metro port, which Stim already makes reachable.`);
    return port;
  }
  if (target === 'metro')
    throw new Error("metro is managed by stim start; Stim already makes this workspace's Metro reachable.");
  if (target === 'web-cdp') throw new Error('web-cdp is managed by stim web; choose another label.');
  const port = project?.ports?.[target];
  if (typeof port !== 'number')
    throw new Error(`No named port ${target}. Run \`stim ports get ${target}\` first, or give the port number.`);
  return port;
}

export async function recordReversePort(root: string, port: number, add: boolean): Promise<number[]> {
  let ports: number[] = [];
  await updateWorkspaceStateAsync(root, (state) => {
    const current = reversePorts(state);
    if (add && !current.includes(port) && current.length >= MAX_REVERSE_PORTS)
      throw new Error(
        `A workspace reverses at most ${MAX_REVERSE_PORTS} ports. Remove one with \`stim ports reverse --remove <port>\`.`,
      );
    ports = add ? [...new Set([...current, port])].toSorted((a, b) => a - b) : current.filter((p) => p !== port);
    const { [REVERSE_PORTS_KEY]: _, ...rest } = state;
    return ports.length ? { ...rest, [REVERSE_PORTS_KEY]: ports } : rest;
  });
  return ports;
}

export interface ReverseDeps {
  resolveAvd: typeof resolveOwnedAvdSerialAsync;
  applyReverse: (serial: string, port: number) => Promise<{ failed?: boolean; reason?: string }>;
  removeReverse: (serial: string, port: number, operation?: StimContext) => Promise<void>;
  leases: typeof listLeaseFiles;
  syncHosted: typeof syncHostedReversesTo;
  requireLinks: typeof requireReverseLinks;
}

const DEFAULT_DEPS: ReverseDeps = {
  resolveAvd: resolveOwnedAvdSerialAsync,
  applyReverse: (serial, port) => reverseMetroPorts({ serial, metroPort: port }),
  removeReverse: (serial, port, operation) => removeMetroReverses(serial, [port], operation),
  leases: listLeaseFiles,
  syncHosted: syncHostedReversesTo,
  requireLinks: requireReverseLinks,
};

const PHYSICAL_IOS_REASON =
  'a physical iPhone has no reverse forward over USB, so its apps reach this Mac only over the network you share';

export async function reverseOnDevices(
  root: string,
  port: number,
  action: 'add' | 'remove',
  deps: Partial<ReverseDeps> = {},
): Promise<ReverseDeviceReport[]> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const state = readWorkspaceState(root);
  const hosted = new Set(
    (['ios', 'android'] as const).flatMap((platform) =>
      Object.keys(hostedNativeRecords(state, platform)).map((slot) => `${platform}:${slot}`),
    ),
  );
  const reports: ReverseDeviceReport[] = [];
  const act = async (platform: 'android', device: string, serial: string) => {
    if (action === 'remove') {
      try {
        await d.removeReverse(serial, port);
        reports.push({ platform, device, status: 'removed', detail: `removed adb reverse tcp:${port}` });
      } catch (error) {
        reports.push({
          platform,
          device,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    const applied = await d.applyReverse(serial, port);
    reports.push(
      applied.failed
        ? {
            platform,
            device,
            status: 'failed',
            detail: applied.reason ?? `adb reverse tcp:${port} failed on ${serial}`,
          }
        : { platform, device, status: 'applied', detail: `adb reverse tcp:${port} tcp:${port}` },
    );
  };
  for (const platform of ['ios', 'android'] as const)
    for (const [slot, placement] of Object.entries(readHostedNative(root, platform))) {
      const device = `hosted ${platform} session${slot === 'default' ? '' : ` [${slot}]`} on ${placement.machine}`;
      try {
        if (action === 'add') d.requireLinks(root);
        const bound = await d.syncHosted(root, placement.machine, placement.session);
        const worker = bound.find((each) => each.port === port);
        if (action === 'remove' || !worker) {
          reports.push({ platform, device, status: 'removed', detail: `localhost:${port} is no longer bridged` });
        } else {
          reports.push({
            platform,
            device,
            status: 'applied',
            detail:
              platform === 'ios'
                ? `${placement.machine} listens on its loopback port ${port} and forwards to this machine`
                : `adb reverse tcp:${port} tcp:${worker.workerPort} on the hosted emulator, forwarded to this machine`,
          });
        }
      } catch (error) {
        reports.push({
          platform,
          device,
          status:
            error instanceof Error && 'code' in error && error.code === 'STIM_HOSTING_REFUSED'
              ? 'unsupported'
              : 'failed',
          detail: [
            error instanceof Error ? error.message : String(error),
            error instanceof Error && 'remedy' in error ? String(error.remedy) : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      }
    }
  const project = getProject(root);
  for (const { slot, platforms } of projectDeviceSlots(project)) {
    const label = slot === 'default' ? '' : ` [${slot}]`;
    if (platforms.ios?.owned && platforms.ios.deviceUdid && !hosted.has(`ios:${slot}`)) {
      reports.push({
        platform: 'ios',
        device: `${platforms.ios.deviceName ?? platforms.ios.deviceUdid}${label}`,
        status: 'reachable',
        detail: `a simulator shares this Mac's loopback, so localhost:${port} is already reachable`,
      });
    }
    const android = platforms.android;
    if (android?.owned && android.avdName && !hosted.has(`android:${slot}`)) {
      const device = `${android.avdName}${label}`;
      const resolved = await d.resolveAvd(android.avdName, {
        preferredSerial: android.consolePort ? `emulator-${android.consolePort}` : undefined,
      });
      if (resolved.serial) await act('android', device, resolved.serial);
      else
        reports.push({
          platform: 'android',
          device,
          status: action === 'add' ? 'pending' : 'removed',
          detail:
            action === 'add'
              ? 'the emulator is not running; stim android applies the reverse when it launches the app'
              : 'the emulator is not running, so it holds no reverse',
        });
    }
  }
  const mine = d
    .leases()
    .filter((entry) => entry.lease && entry.lease.holder === root && !leaseIsExpired(entry.lease, Date.now()));
  const phones = new Set([
    ...readPhoneReverseSerials(root),
    ...mine.flatMap((entry) => (entry.lease?.platform === 'android' ? [entry.lease.id] : [])),
  ]);
  for (const serial of phones) {
    await act('android', serial, serial);
    const last = reports.at(-1);
    if (action === 'add' && last?.status === 'applied')
      await recordPhoneReverse(root, mine.find((e) => e.lease?.id === serial)?.lease?.slot ?? 'default', serial, port);
  }
  if (action === 'remove') await forgetPhoneReverse(root, port);
  for (const entry of mine) {
    if (entry.lease?.platform !== 'ios') continue;
    reports.push({
      platform: 'ios',
      device: entry.lease.deviceName ?? entry.lease.id,
      status: 'unsupported',
      detail: PHYSICAL_IOS_REASON,
    });
  }
  return reports;
}

export async function applyRecordedReverses(
  root: string,
  { slot, serial, physical, remote }: { slot: string; serial: string; physical: boolean; remote: boolean },
  out: (line: string) => void,
  applyReverse: ReverseDeps['applyReverse'] = DEFAULT_DEPS.applyReverse,
): Promise<void> {
  if (remote) return;
  for (const port of reversePorts(readWorkspaceState(root))) {
    const applied = await applyReverse(serial, port);
    if (applied.failed) {
      out(`reverse port ${port}: ${applied.reason ?? 'adb reverse failed'}`);
      continue;
    }
    if (physical) await recordPhoneReverse(root, slot, serial, port);
  }
}

export async function dropLabelReverses(
  root: string,
  label: string | undefined,
  deps: Partial<ReverseDeps> = {},
): Promise<ReverseDeviceReport[]> {
  const reversed = reversePorts(readWorkspaceState(root));
  const released = Object.entries(getProject(root)?.ports ?? {}).flatMap(([name, port]) =>
    name !== 'web-cdp' && (label === undefined || name === label) && reversed.includes(port) ? [port] : [],
  );
  const reports: ReverseDeviceReport[] = [];
  for (const port of released) {
    await recordReversePort(root, port, false);
    reports.push(...(await reverseOnDevices(root, port, 'remove', deps)));
  }
  return reports;
}
