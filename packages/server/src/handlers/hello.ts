import { type PairedDevice, DESKTOP_CLIENT_APPS, recordsForKey, touchDevice } from '../registry.ts';
import type { JsonObject } from '../feed.ts';
import {
  PEER,
  DESKTOP_API,
  PHONE_API,
  type RequestId,
  type HelloResult,
  HOST_CAPABILITIES,
  PROTOCOL_VERSION,
  ACTIONS,
} from '../protocol.ts';
import { send, type ConnectionContext } from './context.ts';
import { isJsonObject, validRunId } from '@stim-cli/core/state';
import { CLOSE_REFUSED, HOME_UNAVAILABLE_MESSAGE } from '@stim-cli/core/noise-session';
import { homedir } from 'node:os';

export const CLOSE_BAD_REQUEST = 4400;

export const LOCAL_DEVICE_ID = 'local';

/** A connection stimd's CLI socket handed over: this server's own user, such as Stim Desktop, with every local capability. */
const LOCAL_DEVICE: PairedDevice = {
  id: LOCAL_DEVICE_ID,
  name: 'Stim Desktop',
  publicKey: '',
  pairedAt: new Date(0).toISOString(),
  lastSeenAt: null,
  capabilities: ['read', 'control'],
};

const CLIENT_PING_MS = 60_000;

const CLIENT_SILENT_MS = 180_000;

const wireInteger = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : 0);

/** Why the network listener turns a client away: a missing or lower integer for the surface it speaks. */
function helloRefusal(client: JsonObject, access: unknown, machine: string, stim: string): string | null {
  // compat C12 permanent
  if (access !== undefined || client.peer !== undefined) {
    const peer = wireInteger(client.peer);
    if (peer >= PEER) return null;
    const sent = peer ? `speaks peer ${peer}` : 'sends no peer';
    return `peer-too-old: ${machine} runs stim ${stim} (peer ${PEER}); this stim ${sent}; update this Mac: npm i -g stim@${stim}, then stim service install if it runs Stim as a service`;
  }
  // compat end
  // compat C7 permanent
  if (client.desktopApi !== undefined || DESKTOP_CLIENT_APPS.includes(String(client.name)))
    return wireInteger(client.desktopApi) >= DESKTOP_API
      ? null
      : `${machine} runs stim ${stim}, which needs a newer Stim Desktop. Update Stim Desktop (Stim > Check for Updates).`;
  // compat end
  // compat C9 permanent
  if (wireInteger(client.phoneApi) >= PHONE_API) return null;
  return `${machine} runs stim ${stim}, which needs a newer Stim Mobile. Update Stim Mobile from the App Store or TestFlight.`;
  // compat end
}

export async function hello(ctx: ConnectionContext, id: RequestId, params: unknown): Promise<void> {
  if (ctx.device)
    return send(ctx.socket, { id, error: { code: 'already-authenticated', message: 'hello was already accepted.' } });
  if (!isJsonObject(params) || !isJsonObject(params.client)) {
    return ctx.refuse(id, 'bad-request', 'hello needs params.client.', CLOSE_BAD_REQUEST);
  }
  const access = params.access;
  if (access !== undefined && access !== 'build' && access !== 'device-host') {
    return ctx.refuse(id, 'bad-request', 'params.access is build or device-host.', CLOSE_BAD_REQUEST);
  }
  if (access === 'device-host' && !ctx.hostsDevices) {
    return ctx.refuse(
      id,
      'forbidden',
      'Hosting simulators needs a Mac. This machine takes build requests only.',
      CLOSE_REFUSED,
    );
  }
  clearTimeout(ctx.timer);
  ctx.runId = validRunId(params.client.runId);
  ctx.tracker.identify({ id: null, runId: ctx.runId });
  const probing = ctx.hostHealth();
  const name = typeof params.client.name === 'string' ? params.client.name.slice(0, 64) : 'Stim Desktop';
  const registries = ctx.local ? null : ctx.readApprovals();
  if (!ctx.local && (!registries || ctx.startup.state !== 'ready'))
    return ctx.refuse(id, 'home-unavailable', HOME_UNAVAILABLE_MESSAGE, CLOSE_REFUSED);
  const keyRecords = ctx.clientKey === null || !registries ? {} : recordsForKey(ctx.clientKey, registries);
  const chosen = ctx.local ? { ...LOCAL_DEVICE, name } : access === undefined ? keyRecords.device : keyRecords[access];
  if (!chosen) {
    return ctx.refuse(
      id,
      access === undefined ? 'unauthorized' : 'forbidden',
      access === undefined
        ? 'This machine has no pairing for this client. Pair again.'
        : `This machine has not approved this client for ${access}. Approve it with \`stim setup\` there.`,
      CLOSE_REFUSED,
    );
  }
  const tooOld = ctx.local ? null : helloRefusal(params.client, access, ctx.options.name, ctx.options.stimVersion);
  if (tooOld) return ctx.refuse(id, 'protocol-unsupported', tooOld, CLOSE_REFUSED);
  ctx.device = chosen;
  if (!ctx.local) touchDevice(ctx.device.id, params.client);
  if (access === 'device-host' && !ctx.local) {
    ctx.hostedDevices.clientSeen(ctx.device.id);
    let heardAt = Date.now();
    let late = false;
    const hear = () => (heardAt = Date.now());
    ctx.socket.on('pong', hear);
    ctx.socket.on('message', hear);
    const { pingMs, silentMs } = ctx.options.clientHeartbeat ?? { pingMs: CLIENT_PING_MS, silentMs: CLIENT_SILENT_MS };
    ctx.clientPing = setInterval(() => {
      if (Date.now() - heardAt > silentMs) {
        if (late) return void ctx.socket.terminate();
        late = true;
      } else late = false;
      ctx.socket.ping();
    }, pingMs);
    ctx.clientPing.unref();
  }
  if (ctx.local && params.desktopBootstrap === true)
    ctx.desktopChallenge = ctx.options.desktopBootstrap?.challenge() ?? null;
  ctx.tracker.identify({ id: ctx.device.id, runId: ctx.runId });
  ctx.sessions.set(ctx.socket, ctx.device);
  ctx.sampler.start();
  const probeWaited = Date.now();
  const host = ctx.options.host ? await probing : undefined;
  if (ctx.options.host) ctx.tracker.step(id, 'probe', Date.now() - probeWaited);
  const result: HelloResult = {
    host: {
      owner: ctx.options.owner ?? (ctx.options.service?.label ? 'service' : 'cli'),
      capabilities: ctx.hostsDevices ? [...HOST_CAPABILITIES] : ['physical-android'],
      app: host ?? null,
    },
    protocol: PROTOCOL_VERSION,
    peer: PEER,
    phoneApi: PHONE_API,
    desktopApi: DESKTOP_API,
    server: {
      name: ctx.options.name,
      version: ctx.options.serverVersion,
      stim: ctx.options.stimVersion,
      home: homedir(),
      id: ctx.homeId,
      ...(ctx.local && ctx.addresses[0] ? { port: ctx.addresses[0].port } : {}),
    },
    capabilities: ctx.device.capabilities,
    actions: ctx.device.capabilities.includes('control') ? [...ACTIONS] : [],
    device: { id: ctx.device.id, name: ctx.device.name },
    ...(ctx.desktopChallenge ? { desktopBootstrap: ctx.desktopChallenge } : {}),
  };
  send(ctx.socket, { id, result });
}
