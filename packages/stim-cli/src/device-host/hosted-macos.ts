import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  hostedMacosBundleId,
  parseHostedMacosDevice,
  validHostedAppArguments,
  type HostedMacosPlacement,
} from '@stim-cli/core/state';
import { macosDir } from '../macos/state.ts';
import { type BuildHandoff } from '../offload/client.ts';
import { agentAccess } from './hosted-agent.ts';
import { phaseLine } from '../command-output.ts';
import { closeAgentConnection } from './agent-connection.ts';
import { pullHostedMacosLogs } from './hosted-logs.ts';
import {
  sleep,
  call,
  connectHost,
  hostedSession,
  attach,
  settle,
  heldNoLonger,
  unknownSession,
  bundleManifest,
  upload,
  sha256,
  POLL_MS,
  SESSION_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  type HostConnection,
  type HostedSession,
} from './hosted-client.ts';
export {
  connectHost,
  probeHostedSession as probeHostedMacos,
  type HostConnection,
  type HostedSessionProbe as HostedMacosProbe,
} from './hosted-client.ts';

const HANDOFF_TIMEOUT_MS = 5 * 60_000;

export const agentRemoteConfig = (root: string): string => join(macosDir(root), 'agent-device-remote.json');

export interface HostedMacosRun {
  placement: HostedMacosPlacement;
  launched: true | 'unverified';
  arguments: string[];
}

/**
 * Places a staged `.app` on `host`: reuses the recorded session when the host still holds it ready, else reserves one,
 * then delivers the bundle as a new app attempt, launches it and waits for the host to report it installed. `reserved`
 * records the placement as soon as a session exists, so `stim stop` can find it even if delivery fails.
 */
export async function placeHostedMacos(
  host: HostConnection,
  {
    root,
    bundle,
    bundleId,
    handoff,
    arguments: requestedArguments,
    recorded,
    reserved,
    note,
  }: {
    root: string;
    bundle: string;
    bundleId: string;
    /** The build machine's copy of `bundle`, which the host takes instead of an upload when it is the same node. */
    handoff?: BuildHandoff | null;
    arguments: string[];
    recorded: HostedMacosPlacement | undefined;
    reserved: (placement: HostedMacosPlacement) => void;
    note: (line: string) => void;
  },
): Promise<HostedMacosRun> {
  let session: HostedSession | null = null;
  if (recorded) {
    try {
      session = await settle(host, await attach(host, recorded.session), ['preparing', 'stopping'], SESSION_TIMEOUT_MS);
    } catch (error) {
      if (!heldNoLonger(error)) throw error;
    }
    if (session?.state === 'unknown') throw unknownSession(host, session);
    if (session?.state === 'stopped') session = null;
  }
  if (!session) {
    note(`Reserving a macOS session on ${host.machine}`);
    session = hostedSession(
      host,
      await call(host, 'device-host.reserve', {
        workspace: root,
        slot: 'default',
        attempt: randomUUID(),
        platform: 'macos',
      }),
    );
  }
  const appSlot = session.appSlot;
  if (appSlot === undefined) throw new Error(`${host.machine} reserved a session without a macOS app slot.`);
  const appAttempt = randomUUID();
  const placement: HostedMacosPlacement = {
    machine: host.machine,
    session: session.id,
    appSlot,
    appAttempt,
    bundleId: hostedMacosBundleId(bundleId, appSlot),
    agent: { driver: 'none', setting: 'hosting.agentDriver' },
  };
  reserved(placement);
  session = await settle(host, session, ['preparing'], SESSION_TIMEOUT_MS);
  if (session.state === 'unknown') throw unknownSession(host, session);
  if (session.state !== 'ready')
    throw new Error(`The hosted session ${session.id} on ${host.machine} is ${session.state}.`);
  const device = parseHostedMacosDevice(session.device);
  if (!device || device.appSlot !== appSlot) {
    throw new Error(`${host.machine} reported a ready session without its reserved macOS app slot.`);
  }
  const { files, content } = bundleManifest(bundle);
  const manifest = Buffer.from(JSON.stringify(files));
  content.set(sha256(manifest), () => manifest);
  const ids = { session: session.id, attempt: appAttempt };
  const offer = {
    ...ids,
    bundleId,
    mode: 'release',
    ...(requestedArguments.length ? { arguments: requestedArguments } : {}),
    manifest: { sha256: sha256(manifest), size: manifest.length },
  };
  note(`Delivering ${files.length} files to ${host.machine} (macOS ${device.macosVersion}, ${device.architecture})`);
  await upload(host, ids, (await call(host, 'device-host.app.offer', offer)).missing, content);
  let missing = (await call(host, 'device-host.app.offer', offer)).missing;
  if (handoff && handoff.nodeId === host.credential.nodeId && Array.isArray(missing) && missing.length) {
    try {
      const taken = await call(
        host,
        'device-host.app.handoff',
        { ...ids, build: { handoff: handoff.token, sha256: handoff.sha256 } },
        HANDOFF_TIMEOUT_MS,
      );
      if (taken.files) note(`${host.machine} took ${String(taken.files)} files from the build it ran`);
    } catch (error) {
      note(`${error instanceof Error ? error.message : String(error)}; uploading the app instead`);
    }
    missing = (await call(host, 'device-host.app.offer', offer)).missing;
  }
  await upload(host, ids, missing, content);
  note(`Launching on ${host.machine}`);
  let delivery = await call(host, 'device-host.app.launch', ids);
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (delivery.state !== 'installed') {
    if (delivery.state === 'unknown') {
      throw new Error(
        `${host.machine} could not install or launch the app${typeof delivery.notice === 'string' ? `: ${delivery.notice}` : ''}.`,
      );
    }
    if (Date.now() > deadline) throw new Error(`${host.machine} did not finish installing the app.`);
    await sleep(POLL_MS);
    delivery = await call(host, 'device-host.app.attach', ids);
  }
  const appliedArguments = validHostedAppArguments(delivery.arguments) ? delivery.arguments : [];
  if (JSON.stringify(appliedArguments) !== JSON.stringify(requestedArguments))
    note(`${host.machine} did not apply macos.arguments. Update stim-server on that host.`);
  if (typeof delivery.notice === 'string') note(delivery.notice);
  return {
    placement: { ...placement, agent: agentAccess(agentRemoteConfig(root), host.credential, delivery.agent, note) },
    launched: delivery.launched === true ? true : 'unverified',
    arguments: appliedArguments,
  };
}

/** Stops a recorded hosted session and waits until the host confirms it stopped; anything else is a failure. */
export async function stopHostedMacos(root: string, placement: HostedMacosPlacement): Promise<void> {
  if (placement.agent.driver === 'agent-device') closeAgentConnection(placement.agent.remoteConfig);
  const host = await connectHost(placement.machine);
  try {
    try {
      let session = hostedSession(host, await call(host, 'device-host.stop', { session: placement.session }));
      session = await settle(host, session, ['stopping'], SESSION_TIMEOUT_MS);
      if (session.state !== 'stopped') throw unknownSession(host, session);
      await pullHostedMacosLogs(root, placement, host).catch((error: unknown) => {
        process.stderr.write(
          `${phaseLine('device', `Could not copy the final logs from ${host.machine}: ${(error as Error).message}`)}\n`,
        );
      });
    } catch (error) {
      if (!heldNoLonger(error)) throw error;
    }
  } finally {
    host.connection.close();
  }
  rmSync(agentRemoteConfig(root), { force: true });
}
