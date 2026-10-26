import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDir } from '../workspace/paths.ts';
import { agentAccess, removeAgentAccess } from './hosted-agent.ts';
import { closeAgentConnection } from './agent-connection.ts';
import { randomUUID } from 'node:crypto';
import type { BuildHandoff } from '../offload/client.ts';
import { pullHostedNativeLogs } from './hosted-logs.ts';
import {
  requireAutomaticMachine,
  parseHostedChoice,
  parseHostedAndroidDevice,
  parseHostedNativeOffer,
  type HostedAndroidChoice,
  type HostedNativePlacement,
  type HostedIosDevice,
  type HostedAndroidDevice,
  parseHostedDevice,
  isJsonObject,
  type HostedDeviceSelectors,
  type HostedIosChoice,
  type HostedAppOffer,
  hostedNativeRecords,
  parseHostedNativePlacement,
  unreadableHostedNative,
} from '@stim-cli/core/state';
import {
  call,
  connectHost,
  requireHostedAppMode,
  attach,
  hostedSession,
  settle,
  heldNoLonger,
  stoppedSession,
  unknownSession,
  bundleManifest,
  sha256,
  upload,
  POLL_MS,
  SESSION_TIMEOUT_MS,
  PREPARE_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  OFFER_TIMEOUT_MS,
  RESERVE_TIMEOUT_MS,
  type HostConnection,
  type HostedSession,
} from './hosted-client.ts';
import { requestHostedMetro, closeHostedMetro, requireHostedMetro } from './metro-request.ts';
import { writeHostedNative } from './ios-state.ts';
import { readWorkspaceState, withWorkspaceStateLockAsync } from '../workspace/workspace-state.ts';
import { cancellableSleep } from '../cancellation.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { withDrainingCancellation } from '../engine/operation-state.ts';
import { ambientContext, ambientWrite } from '@stim-cli/core';

function hostingRefusal(machine: string, error: unknown): Error & { code: string } {
  return Object.assign(new Error(`${machine}: ${error instanceof Error ? error.message : String(error)}`), {
    code: 'STIM_HOSTING_REFUSED',
    ...(error instanceof Error && 'remedy' in error ? { remedy: error.remedy } : {}),
  });
}

export interface HostedNativeTarget {
  host: HostConnection;
  choice: HostedIosChoice | HostedAndroidChoice;
  session: HostedSession | null;
  selection?: { selected: string; reason?: string };
}

export const androidAgentRemoteConfig = (root: string, slot: string): string =>
  join(workspaceDir(root), 'hosted-android', slot, 'agent-device-remote.json');

export const iosAgentRemoteConfig = (root: string, slot: string): string =>
  join(workspaceDir(root), 'hosted-ios', slot, 'agent-device-remote.json');

export function prepareHostedNative(
  machine: string,
  selectors: HostedDeviceSelectors,
  recorded: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> | undefined,
  platform: 'ios' | 'android',
  resumeOnly: true,
  mode?: HostedAppOffer['mode'],
): Promise<HostedNativeTarget | null>;
export function prepareHostedNative(
  machine: string,
  selectors: HostedDeviceSelectors,
  recorded?: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>,
  platform?: 'ios' | 'android',
  resumeOnly?: false,
  mode?: HostedAppOffer['mode'],
): Promise<HostedNativeTarget>;
export async function prepareHostedNative(
  machine: string,
  selectors: HostedDeviceSelectors,
  recorded?: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>,
  platform: 'ios' | 'android' = 'ios',
  resumeOnly = false,
  mode?: HostedAppOffer['mode'],
): Promise<HostedNativeTarget | null> {
  let host: HostConnection | undefined;
  try {
    host = await connectHost(machine, undefined, true);
    requireHostedAppMode(host, platform, mode);
    if (recorded) {
      let session: HostedSession | null = null;
      try {
        session = await settle(
          host,
          await attach(host, recorded.session, undefined, platform),
          ['preparing'],
          PREPARE_TIMEOUT_MS,
          platform,
          runCancellationSignal(ambientContext()),
        );
        session = await settle(
          host,
          session,
          ['stopping'],
          SESSION_TIMEOUT_MS,
          platform,
          runCancellationSignal(ambientContext()),
        );
      } catch (error) {
        if (!heldNoLonger(error)) throw error;
      }
      if (session && session.state !== 'stopped') {
        if (session.state !== 'ready') throw unknownSession(host, session);
        const device =
          platform === 'ios' ? parseHostedDevice(session.device) : parseHostedAndroidDevice(session.device);
        if (!device) throw new Error('The ready session has no simulator identity.');
        if (
          'udid' in device
            ? (selectors.deviceType && selectors.deviceType !== device.deviceType) ||
              (selectors.runtime && selectors.runtime.replace(/^iOS /, '') !== device.runtime.replace(/^iOS /, ''))
            : (selectors.systemImage && selectors.systemImage !== device.systemImage) ||
              (selectors.deviceProfile && selectors.deviceProfile !== device.deviceProfile)
        )
          throw new Error(
            'udid' in device
              ? `This session uses ${device.deviceType} (iOS ${device.runtime.replace(/^iOS /, '')}); run stim stop first to change it.`
              : `This session uses ${device.deviceProfile} (${device.systemImage}); run stim stop first to change it.`,
          );
        return {
          host,
          choice: device,
          session,
          selection: {
            selected: recorded.selected,
            ...(recorded.reason !== undefined ? { reason: recorded.reason } : {}),
          },
        };
      }
    }
    if (resumeOnly) return null;
    const offer = await call(host, 'device-host.offer', { platform, ...selectors }, OFFER_TIMEOUT_MS);
    const parsedOffer = parseHostedNativeOffer(offer);
    const choice =
      platform === 'ios'
        ? offer.platform === 'ios'
          ? parseHostedChoice(offer.choice)
          : null
        : parsedOffer?.platform === 'android'
          ? parsedOffer.choice
          : null;
    if (typeof offer.declined === 'string') throw new Error(offer.declined);
    if (!choice)
      throw new Error(
        platform === 'ios'
          ? 'No compatible installed iOS simulator runtime was offered.'
          : 'No compatible installed Android emulator image was offered.',
      );
    if (!isJsonObject(offer.capacity) || offer.capacity.available === 0)
      throw new Error('No hosted device capacity is available.');
    if (!isJsonObject(offer.resources) || offer.resources.memoryPressure !== 'normal')
      throw new Error('Host memory pressure is unknown or elevated.');
    return { host, choice, session: null };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'STIM_BAD_ARG') throw error;
    throw hostingRefusal(machine, error);
  } finally {
    host?.connection.close();
  }
}

async function reserveHostedNative(
  host: HostConnection,
  target: HostedNativeTarget,
  params: Record<string, unknown>,
  platform: 'ios' | 'android',
): Promise<HostedSession> {
  try {
    if (target.selection?.selected === 'auto') requireAutomaticMachine('device', host.machine);
    return hostedSession(host, await call(host, 'device-host.reserve', params, RESERVE_TIMEOUT_MS), platform);
  } catch (error) {
    if (target.selection?.selected !== 'auto') throw error;
    throw Object.assign(
      new Error(
        `${error instanceof Error ? error.message : String(error)} Retry stim ${platform} --remote auto; the build already targets ${host.machine}'s architecture.`,
      ),
      { remedy: `Retry stim ${platform} --remote auto.` },
    );
  }
}

const HOST_PORT_WINDOW = 64;

const devClientPortRemedy = (machine: string): string =>
  `Run stim stop, then stim ios --remote ${machine} without stim start, so Stim starts Metro on a port free on both Macs. If metro.port or STIM_METRO_PORT pins the port, pin one free on both Macs instead.`;

export const devClientPortBusy = (
  machine: string,
  port: number,
): { code: 'STIM_HOSTING_REFUSED'; message: string; remedy: string } => ({
  code: 'STIM_HOSTING_REFUSED',
  message: `${machine}: Port ${port} is in use on ${machine}, and an Expo dev client loads its bundle from this workspace's Metro port.`,
  remedy: devClientPortRemedy(machine),
});

/**
 * Answers whether a port is free for an Expo dev-client bridge on `machine`, asking the host for a window of ports at
 * a time. A host without `hosted-metro-ports`, or one that cannot answer, counts every port as free; the bridge's own
 * bind check still refuses an occupied one.
 */
export function hostedMetroPortProbe(
  machine: string,
  note: (line: string) => void,
): (port: number) => Promise<boolean> {
  let window: { from: number; busy: ReadonlySet<number> } | null = null;
  let unknown = false;
  return async (port) => {
    if (unknown) return true;
    if (!window || port < window.from || port >= window.from + HOST_PORT_WINDOW) {
      const ports = Array.from({ length: Math.min(HOST_PORT_WINDOW, 65536 - port) }, (_, index) => port + index);
      let host: HostConnection | undefined;
      try {
        host = await connectHost(machine, undefined, false, runCancellationSignal(ambientContext()));
        if (!host.connection.supports('hosted-metro-ports')) {
          unknown = true;
          return true;
        }
        const { busy } = await call(host, 'device-host.metro.ports', { ports });
        if (!Array.isArray(busy) || busy.some((each) => !Number.isInteger(each)))
          throw new Error(`${machine} answered device-host.metro.ports without its busy ports.`);
        window = { from: port, busy: new Set(busy as number[]) };
      } catch (error) {
        runCancellationSignal(ambientContext())?.throwIfAborted();
        unknown = true;
        note(
          `Could not check which Metro ports are free on ${machine} (${error instanceof Error ? error.message : String(error)}); choosing one free here`,
        );
        return true;
      } finally {
        host?.connection.close();
      }
    }
    return !window.busy.has(port);
  };
}

export function placeHostedNative(
  target: HostedNativeTarget,
  options: Parameters<typeof placeHostedNativeOnce>[1],
): ReturnType<typeof placeHostedNativeOnce> {
  const context = ambientContext();
  return withDrainingCancellation(context, runCancellationSignal(context), () =>
    placeHostedNativeOnce(target, options),
  );
}

async function placeHostedNativeOnce(
  target: HostedNativeTarget,
  {
    root,
    slot,
    bundle,
    handoff,
    bundleId,
    selectors,
    release,
    mode = release ? 'release' : 'development',
    devClientScheme,
    reserved,
    note,
    enterPhase = () => {},
    metro = requestHostedMetro,
    metroPort,
    platform = 'ios',
  }: {
    root: string;
    slot: string;
    bundle: string;
    handoff?: BuildHandoff | null;
    metroPort?: number | null;
    platform?: 'ios' | 'android';
    bundleId: string;
    selectors: HostedDeviceSelectors;
    release: boolean;
    mode?: HostedAppOffer['mode'];
    devClientScheme?: string;
    reserved: (placement: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>) => unknown;
    note: (line: string) => void;
    enterPhase?: (phase: 'device' | 'install' | 'launch') => void;
    metro?: typeof requestHostedMetro;
  },
): Promise<{ placement: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>; launched: true | 'unverified' }> {
  let host = target.host;
  const signal = runCancellationSignal(ambientContext());
  const closeOnAbort = () => host.connection.close();
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  try {
    if (mode === 'development' && metro === requestHostedMetro) requireHostedMetro(root);
    enterPhase('device');
    host = await connectHost(host.machine, undefined, true, signal);
    target.host = host;
    requireHostedAppMode(host, platform, mode);
    if (mode === 'development' && !host.connection.supports('hosted-metro-link'))
      throw Object.assign(new Error(`${host.machine} runs a stim-server that cannot link Metro.`), {
        code: 'STIM_HOSTING_REFUSED',
        remedy: `Update stim-server on ${host.machine}, then retry.`,
      });
    let session =
      (target.session ? await attach(host, target.session.id, undefined, platform) : null) ??
      (await reserveHostedNative(
        host,
        target,
        {
          platform,
          workspace: root,
          slot,
          attempt: randomUUID(),
          ...selectors,
          ...(platform === 'android' && 'systemImage' in target.choice
            ? { systemImage: target.choice.systemImage, deviceProfile: target.choice.deviceProfile }
            : {}),
        },
        platform,
      ));
    let placement: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> = {
      machine: host.machine,
      selected: target.selection?.selected ?? host.machine,
      ...(target.selection ? { reason: target.selection.reason } : {}),
      session: session.id,
      appAttempt: randomUUID(),
      device: platform === 'ios' ? parseHostedDevice(session.device) : parseHostedAndroidDevice(session.device),
      agent: { driver: 'none', setting: 'hosting.agentDriver' },
    };
    await reserved(placement);
    session = await settle(
      host,
      session,
      ['preparing'],
      PREPARE_TIMEOUT_MS,
      platform,
      runCancellationSignal(ambientContext()),
    );
    if (session.state === 'stopped') throw stoppedSession(host, session);
    if (session.state !== 'ready') throw unknownSession(host, session);
    const device = platform === 'ios' ? parseHostedDevice(session.device) : parseHostedAndroidDevice(session.device);
    if (
      !device ||
      device.architecture !== target.choice.architecture ||
      ('avdName' in device &&
        'systemImage' in target.choice &&
        (device.systemImage !== target.choice.systemImage || device.deviceProfile !== target.choice.deviceProfile))
    )
      throw new Error(
        platform === 'ios'
          ? 'The reserved simulator does not match the offered architecture.'
          : 'The reserved emulator does not match the offered architecture or selectors.',
      );
    placement = { ...placement, device };
    await reserved(placement);
    if (mode === 'development') {
      await metro(root, session.id, host.credential);
      await call(host, 'device-host.metro.open', {
        session: session.id,
        ...(platform === 'android' || devClientScheme ? { clientMetroPort: metroPort } : {}),
      }).catch((error: unknown) => {
        if (platform === 'ios' && devClientScheme && (error as { code?: unknown }).code === 'device-busy')
          throw Object.assign(error as Error, { remedy: devClientPortRemedy(host.machine) });
        throw error;
      });
    } else {
      await call(host, 'device-host.metro.close', { session: session.id });
      await closeHostedMetro(root, session.id);
    }
    const { files, content } =
      platform === 'ios'
        ? bundleManifest(bundle)
        : (() => {
            const apk = readFileSync(bundle);
            const digest = sha256(apk);
            return {
              files: [{ path: 'App.apk', kind: 'file', size: apk.length, sha256: digest }],
              content: new Map([[digest, () => apk]]),
            };
          })();
    const manifest = Buffer.from(JSON.stringify(files));
    content.set(sha256(manifest), () => manifest);
    const ids = { session: session.id, attempt: placement.appAttempt };
    const offer = {
      ...ids,
      bundleId,
      mode,
      ...(mode === 'development' && devClientScheme ? { devClientScheme } : {}),
      manifest: { sha256: sha256(manifest), size: manifest.length },
    };
    enterPhase('install');
    note(
      `Delivering ${files.length} files to ${host.machine} (${'runtime' in device ? device.runtime : device.systemImage}, ${device.architecture})`,
    );
    await upload(host, ids, (await call(host, 'device-host.app.offer', offer)).missing, content);
    let missing = (await call(host, 'device-host.app.offer', offer)).missing;
    if (handoff && handoff.serverKey === host.credential.serverKey && Array.isArray(missing) && missing.length) {
      if (!host.connection.supports(platform === 'android' ? 'hosted-android-data' : 'hosted-ios-data')) {
        note(
          `${host.machine} needs a newer stim-server for ${platform === 'ios' ? 'iOS' : 'Android'} build handoff; uploading the app instead`,
        );
      } else {
        try {
          const taken = await call(
            host,
            'device-host.app.handoff',
            { ...ids, build: { handoff: handoff.token, sha256: handoff.sha256 } },
            60_000,
          );
          if (taken.files) note(`${host.machine} took ${String(taken.files)} files from the build it ran`);
          missing = (await call(host, 'device-host.app.offer', offer)).missing;
        } catch (error) {
          note(`${error instanceof Error ? error.message : String(error)}; uploading the app instead`);
          const fallbackDeadline = Date.now() + 60_000;
          for (;;) {
            try {
              missing = (
                await call(
                  host,
                  'device-host.app.offer',
                  offer,
                  Math.max(1, Math.min(20_000, fallbackDeadline - Date.now())),
                )
              ).missing;
              break;
            } catch (offerError) {
              if (!String(offerError).includes('native operation in progress') || Date.now() >= fallbackDeadline)
                throw offerError;
              await cancellableSleep(Math.min(POLL_MS, Math.max(0, fallbackDeadline - Date.now())), {
                signal: runCancellationSignal(ambientContext()),
                what: 'hosted app offer',
              });
            }
          }
        }
      }
    }
    await upload(host, ids, missing, content);
    enterPhase('launch');
    note(`Launching on ${host.machine}`);
    let delivery = await call(host, 'device-host.app.launch', ids);
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    while (delivery.state !== 'installed') {
      if (delivery.state === 'unknown')
        throw new Error(
          typeof delivery.notice === 'string' ? delivery.notice : 'App installation or launch is unknown.',
        );
      if (Date.now() > deadline) throw new Error('App installation did not finish.');
      await cancellableSleep(POLL_MS, {
        signal: runCancellationSignal(ambientContext()),
        what: 'hosted app installation',
      });
      delivery = await call(host, 'device-host.app.attach', ids);
    }
    if (typeof delivery.notice === 'string') note(delivery.notice);
    placement = {
      ...placement,
      agent: await agentAccess(
        platform === 'ios' ? iosAgentRemoteConfig(root, slot) : androidAgentRemoteConfig(root, slot),
        host.credential,
        host.connection.supports(platform === 'ios' ? 'hosted-ios-agent' : 'hosted-android-agent')
          ? delivery.agent
          : undefined,
        note,
        platform,
      ),
    };
    return { placement, launched: mode !== 'development' && delivery.launched === true ? true : 'unverified' };
  } catch (error) {
    throw hostingRefusal(host.machine, error);
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    if (platform === 'android') host.connection.close();
  }
}

export async function stopHostedNative(
  root: string,
  slot?: string,
  signal?: AbortSignal,
  platform: 'ios' | 'android' = 'ios',
): Promise<void> {
  signal?.throwIfAborted();
  const failures: string[] = [];
  for (const [name, record] of Object.entries(hostedNativeRecords(readWorkspaceState(root), platform))) {
    signal?.throwIfAborted();
    if (slot !== undefined && name !== slot) continue;
    const placement = parseHostedNativePlacement(record, platform);
    if (!placement) {
      failures.push(unreadableHostedNative(name, platform));
      continue;
    }
    if (placement.agent.driver === 'agent-device') closeAgentConnection(placement.agent.remoteConfig);
    let host: HostConnection | undefined;
    const cancel = () => host?.connection.close();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      host = await connectHost(placement.machine, undefined, false, signal);
      const stopped = await settle(
        host,
        hostedSession(host, await call(host, 'device-host.stop', { session: placement.session }), platform),
        ['stopping'],
        SESSION_TIMEOUT_MS,
        platform,
        signal,
      );
      signal?.throwIfAborted();
      if (stopped.state !== 'stopped') throw unknownSession(host, stopped);
      try {
        await pullHostedNativeLogs(root, name, placement, host, true, platform, signal);
      } catch (error) {
        signal?.throwIfAborted();
        ambientWrite(
          'stderr',
          `Could not copy the host's final native logs from ${placement.machine}: ${(error as Error).message}\n`,
        );
      }
    } catch (error) {
      signal?.throwIfAborted();
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      const hostCode = error instanceof Error && 'hostCode' in error ? error.hostCode : code;
      if (hostCode !== 'unknown-session' && hostCode !== 'forbidden') {
        const remedy =
          code === 'closed' || code === 'timeout'
            ? 'rerun stim stop when that machine answers.'
            : code === 'STIM_BAD_ARG' || code === 'STIM_HOSTING_REFUSED'
              ? 'run stim doctor, restore hosting access, then rerun stim stop.'
              : 'run stim stop to reconcile the session.';
        failures.push(
          `Could not stop the ${platform === 'ios' ? 'iOS simulator' : 'Android emulator'} on ${placement.machine}: ${(error instanceof Error ? error.message : String(error)).replace(/\.+$/, '')}. The placement is kept; ${remedy}`,
        );
        continue;
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      host?.connection.close();
    }
    signal?.throwIfAborted();
    try {
      await closeHostedMetro(root, placement.session, signal);
      signal?.throwIfAborted();
      await removeAgentAccess(
        platform === 'ios' ? iosAgentRemoteConfig(root, name) : androidAgentRemoteConfig(root, name),
      );
      await withWorkspaceStateLockAsync(root, () => writeHostedNative(root, name, null, platform), signal);
    } catch (error) {
      signal?.throwIfAborted();
      failures.push(`${placement.machine}: ${(error as Error).message}. The placement is kept; rerun stim stop.`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
