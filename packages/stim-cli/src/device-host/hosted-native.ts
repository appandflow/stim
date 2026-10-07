import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDir } from '../workspace/paths.ts';
import { agentAccess } from './hosted-agent.ts';
import { closeAgentConnection } from './agent-connection.ts';
import { randomUUID } from 'node:crypto';
import type { BuildHandoff } from '../offload/client.ts';
import { pullHostedIosLogs } from './hosted-logs.ts';
import {
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
  type HostedIosPlacement,
  hostedNativeRecords,
  parseHostedNativePlacement,
  unreadableHostedNative,
} from '@stim-cli/core/state';
import {
  call,
  connectHost,
  attach,
  hostedSession,
  settle,
  heldNoLonger,
  unknownSession,
  bundleManifest,
  sha256,
  upload,
  sleep,
  POLL_MS,
  SESSION_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  type HostConnection,
  type HostedSession,
} from './hosted-client.ts';
import { requestHostedMetro, closeHostedMetro, requireHostedMetro } from './metro-gateway.ts';
import { writeHostedNative } from './ios-state.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

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
}

export const iosAgentRemoteConfig = (root: string, slot: string): string =>
  join(workspaceDir(root), 'hosted-ios', slot, 'agent-device-remote.json');

export async function prepareHostedNative(
  machine: string,
  selectors: HostedDeviceSelectors,
  recorded?: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>,
  platform: 'ios' | 'android' = 'ios',
): Promise<HostedNativeTarget> {
  let host: HostConnection | undefined;
  try {
    host = await connectHost(machine, undefined, true);
    if (recorded) {
      let session: HostedSession | null = null;
      try {
        session = await settle(
          host,
          await attach(host, recorded.session, undefined, platform),
          ['preparing', 'stopping'],
          SESSION_TIMEOUT_MS,
          platform,
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
        return { host, choice: device, session };
      }
    }
    const offer = await call(host, 'device-host.offer', { platform, ...selectors }, 3000);
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

export async function placeHostedNative(
  target: HostedNativeTarget,
  {
    root,
    slot,
    bundle,
    handoff,
    bundleId,
    selectors,
    release,
    devClientScheme,
    reserved,
    note,
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
    devClientScheme?: string;
    reserved: (placement: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>) => void;
    note: (line: string) => void;
    metro?: typeof requestHostedMetro;
  },
): Promise<{ placement: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>; launched: true | 'unverified' }> {
  let host = target.host;
  try {
    if (!release && metro === requestHostedMetro) requireHostedMetro(root);
    host = await connectHost(host.machine, undefined, true);
    target.host = host;
    let session =
      (target.session ? await attach(host, target.session.id, undefined, platform) : null) ??
      hostedSession(
        host,
        await call(host, 'device-host.reserve', {
          platform,
          workspace: root,
          slot,
          attempt: randomUUID(),
          ...selectors,
          ...(platform === 'android' && 'systemImage' in target.choice
            ? { systemImage: target.choice.systemImage, deviceProfile: target.choice.deviceProfile }
            : {}),
        }),
        platform,
      );
    let placement: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> = {
      machine: host.machine,
      selected: host.machine,
      session: session.id,
      appAttempt: randomUUID(),
      device: platform === 'ios' ? parseHostedDevice(session.device) : parseHostedAndroidDevice(session.device),
      agent: { driver: 'none', setting: 'hosting.agentDriver' },
    };
    reserved(placement);
    session = await settle(host, session, ['preparing'], SESSION_TIMEOUT_MS, platform);
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
    reserved(placement);
    if (!release) {
      const gateway = await metro(root, session.id, host.credential);
      await call(host, 'device-host.metro.open', {
        session: session.id,
        ...gateway,
        ...(platform === 'android' ? { clientMetroPort: metroPort } : {}),
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
      mode: release ? 'release' : 'development',
      ...(!release && devClientScheme ? { devClientScheme } : {}),
      manifest: { sha256: sha256(manifest), size: manifest.length },
    };
    note(
      `Delivering ${files.length} files to ${host.machine} (${'runtime' in device ? device.runtime : device.systemImage}, ${device.architecture})`,
    );
    await upload(host, ids, (await call(host, 'device-host.app.offer', offer)).missing, content);
    let missing = (await call(host, 'device-host.app.offer', offer)).missing;
    if (
      platform === 'ios' &&
      handoff &&
      handoff.nodeId === host.credential.nodeId &&
      Array.isArray(missing) &&
      missing.length
    ) {
      if (!host.connection.supports('hosted-ios-data')) {
        note(`${host.machine} needs a newer stim-server for iOS build handoff; uploading the app instead`);
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
              await sleep(Math.min(POLL_MS, Math.max(0, fallbackDeadline - Date.now())));
            }
          }
        }
      }
    }
    await upload(host, ids, missing, content);
    note(`Launching on ${host.machine}`);
    let delivery = await call(host, 'device-host.app.launch', ids);
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    while (delivery.state !== 'installed') {
      if (delivery.state === 'unknown')
        throw new Error(
          typeof delivery.notice === 'string' ? delivery.notice : 'App installation or launch is unknown.',
        );
      if (Date.now() > deadline) throw new Error('App installation did not finish.');
      await sleep(POLL_MS);
      delivery = await call(host, 'device-host.app.attach', ids);
    }
    if (typeof delivery.notice === 'string') note(delivery.notice);
    placement = {
      ...placement,
      agent:
        platform === 'ios'
          ? agentAccess(
              iosAgentRemoteConfig(root, slot),
              host.credential,
              host.connection.supports('hosted-ios-agent') ? delivery.agent : undefined,
              note,
              'ios',
            )
          : placement.agent,
    };
    return { placement, launched: release && delivery.launched === true ? true : 'unverified' };
  } catch (error) {
    throw hostingRefusal(host.machine, error);
  } finally {
    if (platform === 'android') host.connection.close();
  }
}

export async function stopHostedNative(
  root: string,
  slot?: string,
  platform: 'ios' | 'android' = 'ios',
): Promise<void> {
  const failures: string[] = [];
  for (const [name, record] of Object.entries(hostedNativeRecords(readWorkspaceState(root), platform))) {
    if (slot !== undefined && name !== slot) continue;
    const placement = parseHostedNativePlacement(record, platform);
    if (!placement) {
      failures.push(unreadableHostedNative(name, platform));
      continue;
    }
    if (placement.agent.driver === 'agent-device') closeAgentConnection(placement.agent.remoteConfig);
    let host: HostConnection | undefined;
    try {
      host = await connectHost(placement.machine);
      try {
        if (platform === 'ios') await pullHostedIosLogs(root, name, placement as HostedIosPlacement, host, true);
      } catch (error) {
        process.stderr.write(
          `Could not copy final native logs from ${placement.machine}: ${(error as Error).message}\n`,
        );
      }
      const stopped = await settle(
        host,
        hostedSession(host, await call(host, 'device-host.stop', { session: placement.session }), platform),
        ['stopping'],
        SESSION_TIMEOUT_MS,
        platform,
      );
      if (stopped.state !== 'stopped') throw unknownSession(host, stopped);
      try {
        if (platform === 'ios') await pullHostedIosLogs(root, name, placement as HostedIosPlacement, host, true);
      } catch (error) {
        process.stderr.write(
          `Could not copy the host's final native logs from ${placement.machine}: ${(error as Error).message}\n`,
        );
      }
    } catch (error) {
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
      host?.connection.close();
    }
    try {
      await closeHostedMetro(root, placement.session);
      if (platform === 'ios') rmSync(iosAgentRemoteConfig(root, name), { force: true });
      writeHostedNative(root, name, null, platform);
    } catch (error) {
      failures.push(`${placement.machine}: ${(error as Error).message}. The placement is kept; rerun stim stop.`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
