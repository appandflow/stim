import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDir } from '../workspace/paths.ts';
import { agentAccess } from './hosted-agent.ts';
import { closeAgentConnection } from './agent-connection.ts';
import { randomUUID } from 'node:crypto';
import {
  parseHostedChoice,
  parseHostedDevice,
  isJsonObject,
  type HostedDeviceSelectors,
  type HostedIosChoice,
  type HostedIosPlacement,
  hostedIosRecords,
  parseHostedIosPlacement,
  unreadableHostedIos,
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
import { writeHostedIos } from './ios-state.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

function hostingRefusal(machine: string, error: unknown): Error & { code: string } {
  return Object.assign(new Error(`${machine}: ${error instanceof Error ? error.message : String(error)}`), {
    code: 'STIM_HOSTING_REFUSED',
    ...(error instanceof Error && 'remedy' in error ? { remedy: error.remedy } : {}),
  });
}

export interface HostedIosTarget {
  host: HostConnection;
  choice: HostedIosChoice;
  session: HostedSession | null;
}

export const iosAgentRemoteConfig = (root: string, slot: string): string =>
  join(workspaceDir(root), 'hosted-ios', slot, 'agent-device-remote.json');

export async function prepareHostedIos(
  machine: string,
  selectors: HostedDeviceSelectors,
  recorded?: HostedIosPlacement,
): Promise<HostedIosTarget> {
  let host: HostConnection | undefined;
  try {
    host = await connectHost(machine, undefined, true);
    if (recorded) {
      let session: HostedSession | null = null;
      try {
        session = await settle(
          host,
          await attach(host, recorded.session, undefined, 'ios'),
          ['preparing', 'stopping'],
          SESSION_TIMEOUT_MS,
          'ios',
        );
      } catch (error) {
        if (!heldNoLonger(error)) throw error;
      }
      if (session && session.state !== 'stopped') {
        if (session.state !== 'ready') throw unknownSession(host, session);
        const device = parseHostedDevice(session.device);
        if (!device) throw new Error('The ready session has no simulator identity.');
        if (
          (selectors.deviceType && selectors.deviceType !== device.deviceType) ||
          (selectors.runtime && selectors.runtime.replace(/^iOS /, '') !== device.runtime.replace(/^iOS /, ''))
        )
          throw new Error(
            `This session uses ${device.deviceType} (iOS ${device.runtime.replace(/^iOS /, '')}); run stim stop first to change it.`,
          );
        return { host, choice: device, session };
      }
    }
    const offer = await call(host, 'device-host.offer', { platform: 'ios', ...selectors }, 3000);
    const choice = offer.platform === 'ios' ? parseHostedChoice(offer.choice) : null;
    if (typeof offer.declined === 'string') throw new Error(offer.declined);
    if (!choice) throw new Error('No compatible installed iOS simulator runtime was offered.');
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

export async function placeHostedIos(
  target: HostedIosTarget,
  {
    root,
    slot,
    bundle,
    bundleId,
    selectors,
    release,
    devClientScheme,
    reserved,
    note,
    metro = requestHostedMetro,
  }: {
    root: string;
    slot: string;
    bundle: string;
    bundleId: string;
    selectors: HostedDeviceSelectors;
    release: boolean;
    devClientScheme?: string;
    reserved: (placement: HostedIosPlacement) => void;
    note: (line: string) => void;
    metro?: typeof requestHostedMetro;
  },
): Promise<{ placement: HostedIosPlacement; launched: true | 'unverified' }> {
  let host = target.host;
  try {
    if (!release && metro === requestHostedMetro) requireHostedMetro(root);
    host = await connectHost(host.machine, undefined, true);
    target.host = host;
    let session =
      (target.session ? await attach(host, target.session.id, undefined, 'ios') : null) ??
      hostedSession(
        host,
        await call(host, 'device-host.reserve', {
          platform: 'ios',
          workspace: root,
          slot,
          attempt: randomUUID(),
          ...selectors,
        }),
        'ios',
      );
    let placement: HostedIosPlacement = {
      machine: host.machine,
      selected: host.machine,
      session: session.id,
      appAttempt: randomUUID(),
      device: parseHostedDevice(session.device),
      agent: { driver: 'none', setting: 'hosting.agentDriver' },
    };
    reserved(placement);
    session = await settle(host, session, ['preparing'], SESSION_TIMEOUT_MS, 'ios');
    if (session.state !== 'ready') throw unknownSession(host, session);
    const device = parseHostedDevice(session.device);
    if (!device || device.architecture !== target.choice.architecture)
      throw new Error('The reserved simulator does not match the offered architecture.');
    placement = { ...placement, device };
    reserved(placement);
    if (!release) {
      const gateway = await metro(root, session.id, host.credential);
      await call(host, 'device-host.metro.open', { session: session.id, ...gateway });
    } else {
      await call(host, 'device-host.metro.close', { session: session.id });
      await closeHostedMetro(root, session.id);
    }
    const { files, content } = bundleManifest(bundle);
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
    note(`Delivering ${files.length} files to ${host.machine} (${device.runtime}, ${device.architecture})`);
    await upload(host, ids, (await call(host, 'device-host.app.offer', offer)).missing, content);
    await upload(host, ids, (await call(host, 'device-host.app.offer', offer)).missing, content);
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
      agent: agentAccess(
        iosAgentRemoteConfig(root, slot),
        host.credential,
        host.connection.features?.includes('hosted-ios-agent') ? delivery.agent : undefined,
        note,
        'ios',
      ),
    };
    return { placement, launched: release && delivery.launched === true ? true : 'unverified' };
  } catch (error) {
    throw hostingRefusal(host.machine, error);
  }
}

export async function stopHostedIos(root: string, slot?: string): Promise<void> {
  const failures: string[] = [];
  for (const [name, record] of Object.entries(hostedIosRecords(readWorkspaceState(root)))) {
    if (slot !== undefined && name !== slot) continue;
    const placement = parseHostedIosPlacement(record);
    if (!placement) {
      failures.push(unreadableHostedIos(name));
      continue;
    }
    if (placement.agent.driver === 'agent-device') closeAgentConnection(placement.agent.remoteConfig);
    let host: HostConnection | undefined;
    try {
      host = await connectHost(placement.machine);
      const stopped = await settle(
        host,
        hostedSession(host, await call(host, 'device-host.stop', { session: placement.session }), 'ios'),
        ['stopping'],
        SESSION_TIMEOUT_MS,
        'ios',
      );
      if (stopped.state !== 'stopped') throw unknownSession(host, stopped);
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
          `Could not stop the iOS simulator on ${placement.machine}: ${(error instanceof Error ? error.message : String(error)).replace(/\.+$/, '')}. The placement is kept; ${remedy}`,
        );
        continue;
      }
    } finally {
      host?.connection.close();
    }
    try {
      await closeHostedMetro(root, placement.session);
      rmSync(iosAgentRemoteConfig(root, name), { force: true });
      writeHostedIos(root, name, null);
    } catch (error) {
      failures.push(`${placement.machine}: ${(error as Error).message}. The placement is kept; rerun stim stop.`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
