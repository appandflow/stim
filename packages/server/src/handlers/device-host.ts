import { send, type AgentLink, INPUT_METHODS, type ConnectionContext } from './context.ts';
import { type Duplex, duplexPair } from 'node:stream';
import type { RequestId, MetroLinkOpenEvent } from '../protocol.ts';
import type { PairedDevice } from '../registry.ts';
import type { MetroLink } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';
import { type ScreenSize, simulatorScreen, androidScreen } from '../device-screen.ts';
import { subscribeFrames } from './frames.ts';
import { input } from './control.ts';

const ATTACHED_WORK = new Set([
  'device-host.runtime.install',
  'device-host.offer',
  'device-host.reserve',
  'device-host.app.offer',
  'device-host.app.chunk',
  'device-host.app.handoff',
  'device-host.app.launch',
]);

const CLOSE_METRO_RESET = 4410;

const METRO_LINK_PING_MS = 15_000;

const MAX_AGENT_LINKS = 16;

const AGENT_LINK_IDLE_MS = 5 * 60_000;

const METRO_LINK_BUFFERED_BYTES = 1024 * 1024;

function carry(ctx: ConnectionContext, stream: Duplex): void {
  clearInterval(ctx.metroPing);
  ctx.metroLink = null;
  ctx.metroStream = stream;
  stream.once('close', (hadError) => ctx.socket.close(hadError ? CLOSE_METRO_RESET : 1000));
  stream.on('data', (chunk: Buffer) => {
    ctx.socket.send(chunk, { binary: true }, () => {
      if (stream.isPaused() && ctx.socket.bufferedAmount < METRO_LINK_BUFFERED_BYTES) stream.resume();
    });
    if (ctx.socket.bufferedAmount >= METRO_LINK_BUFFERED_BYTES) stream.pause();
  });
}

// @ref LLP 0010#the-client-opens-every-bridge -- clients can run behind a one-way connection
function linkMetro(ctx: ConnectionContext, id: RequestId, raw: unknown, session: PairedDevice): void {
  if (ctx.metroLink || ctx.metroStream) return ctx.error(id, 'bad-request', 'This connection already links Metro.');
  const link: MetroLink = {
    open: (stream) => {
      if (ctx.socket.readyState !== ctx.socket.OPEN) return false;
      carry(ctx, stream);
      send(ctx.socket, JSON.stringify({ event: 'device-host.metro.link.open' } satisfies MetroLinkOpenEvent));
      stream.resume();
      return true;
    },
    close: () => ctx.socket.close(1000),
  };
  const answer = ctx.hostedDevices.metroLink(session.id, raw, link);
  if ('error' in answer) return send(ctx.socket, { id, error: answer.error });
  send(ctx.socket, { id, result: answer.result });
  if (ctx.metroStream) return;
  ctx.metroLink = link;
  let heard = true;
  ctx.socket.on('pong', () => (heard = true));
  ctx.metroPing = setInterval(() => {
    if (!heard) return void ctx.socket.terminate();
    heard = false;
    ctx.socket.ping();
  }, METRO_LINK_PING_MS);
  ctx.metroPing.unref();
}

function linkAgent(ctx: ConnectionContext, id: RequestId, raw: unknown, session: PairedDevice): void {
  if (ctx.metroLink || ctx.metroStream) return ctx.error(id, 'bad-request', 'This connection already carries a link.');
  const hosted = isJsonObject(raw) && typeof raw.session === 'string' ? raw.session : null;
  if (hosted === null) return ctx.error(id, 'bad-request', 'An agent link needs a session.');
  if (ctx.agentDrivers.holder(hosted) !== session.id)
    return ctx.error(id, 'unknown-session', 'This client has no hosted session with agent control by that id.');
  const [inside, outside] = duplexPair();
  const link: AgentLink = { client: session.id, session: hosted, busy: 0 };
  ctx.agentLinks.set(inside, link);
  const streams = ctx.agentStreams.get(hosted) ?? new Set<Duplex>();
  ctx.agentStreams.set(hosted, streams.add(outside));
  outside.once('close', () => {
    streams.delete(outside);
    if (streams.size === 0 && ctx.agentStreams.get(hosted) === streams) ctx.agentStreams.delete(hosted);
  });
  let excess = [...streams].filter((stream) => !stream.destroyed).length - MAX_AGENT_LINKS;
  for (const oldest of streams) if (!oldest.destroyed && excess-- > 0) oldest.destroy();
  let heard = true;
  ctx.socket.on('pong', () => (heard = true));
  const idle = setTimeout(() => {
    if (link.busy === 0 || !heard) return void outside.destroy();
    heard = false;
    ctx.socket.ping();
    idle.refresh();
  }, AGENT_LINK_IDLE_MS);
  idle.unref();
  const active = () => idle.refresh();
  ctx.socket.on('message', active);
  outside.on('data', active);
  outside.once('close', () => clearTimeout(idle));
  outside.once('end', () => outside.end());
  outside.once('close', () => inside.destroy());
  inside.once('close', () => {
    outside.push(null);
    outside.end();
  });
  send(ctx.socket, { id, result: {} });
  carry(ctx, outside);
  ctx.agentHttp.emit('connection', inside);
}

export async function hostedMethod(
  ctx: ConnectionContext,
  id: RequestId,
  method: string,
  raw: unknown,
  session: PairedDevice,
): Promise<void> {
  if (ctx.options.attached && ATTACHED_WORK.has(method))
    return ctx.error(
      id,
      'device-busy',
      'This machine is serving from an attached Stim command. After that command ends, run `stim serve` outside the agent command, then retry.',
    );
  if (method === 'device-host.metro.link') return linkMetro(ctx, id, raw, session);
  if (method === 'device-host.agent.link') return linkAgent(ctx, id, raw, session);
  const params = isJsonObject(raw) ? raw : {};
  if (method === 'device-host.frames.subscribe' || method === 'device-host.control.begin') {
    if (typeof params.session !== 'string') return ctx.error(id, 'bad-request', 'A hosted session is required.');
    if (method === 'device-host.control.begin' && params.takeOver !== undefined && typeof params.takeOver !== 'boolean')
      return ctx.error(id, 'bad-request', 'takeOver must be true or false.');
    if (method === 'device-host.frames.subscribe' && (params.at !== undefined || params.rate !== undefined))
      return ctx.error(id, 'bad-request', 'Hosted recorded replay is not supported.');
    try {
      const hostedSession = params.session;
      if (method === 'device-host.frames.subscribe') {
        const view = ctx.hostedViews.target(session.id, hostedSession);
        return subscribeFrames(
          ctx,
          id,
          { ...params, workspace: view.workspace, platform: view.device.platform, slot: view.slot },
          { client: session.id, session: hostedSession, view },
        );
      }
      const owner = ctx.controller(session);
      const outcome = await ctx.hostedViews.begin(
        session.id,
        hostedSession,
        owner,
        params.takeOver === true,
        () => ctx.socket.readyState === ctx.socket.OPEN && ctx.controllers.get(ctx.socket) === owner,
      );
      return 'code' in outcome
        ? ctx.error(id, outcome.code, outcome.message)
        : send(ctx.socket, { id, result: outcome });
    } catch (cause) {
      return ctx.error(id, 'action-failed', (cause as Error).message);
    }
  }
  if (method === 'device-host.presence.subscribe') {
    const hostedSession = params.session;
    if (typeof hostedSession !== 'string' || !ctx.hostedDevices.owns(session.id, hostedSession))
      return ctx.error(id, 'unknown-session', 'This client has no such ready hosted session.');
    const subscription = ctx.openSubscription(id);
    if (!subscription) return;
    ctx.subscriptions.set(
      subscription,
      ctx.hostedPresence.subscribe(
        hostedSession,
        (participants) => send(ctx.socket, { event: 'presence', subscription, participants }),
        async (): Promise<ScreenSize | null> => {
          const target = ctx.hostedDevices.viewTarget(session.id, hostedSession);
          if (target.platform === 'ios') return simulatorScreen(target.session.device.udid, ctx.options.env);
          if (target.platform === 'android') return androidScreen(target.session.device.serial, ctx.options.env);
          return null;
        },
      ),
    );
    return;
  }
  if (method === 'device-host.frames.keyframe') {
    const name = params.subscription;
    const keyframe = typeof name === 'string' ? ctx.keyframes.get(name) : undefined;
    if (!keyframe) return ctx.error(id, 'unknown-subscription', `No video subscription ${String(name)}.`);
    keyframe();
    return send(ctx.socket, { id, result: {} });
  }
  if (method === 'device-host.frames.congested') {
    const name = params.subscription;
    const congested = typeof name === 'string' ? ctx.congestion.get(name) : undefined;
    if (!congested) return ctx.error(id, 'unknown-subscription', `No video subscription ${String(name)}.`);
    congested();
    return send(ctx.socket, { id, result: {} });
  }
  if (method === 'device-host.unsubscribe') return ctx.unsubscribeRequest(id, params.subscription);
  if (method === 'device-host.control.end') {
    const name = params.session;
    if (typeof name !== 'string' || !ctx.control.endById(ctx.controller(session), name))
      return ctx.error(id, 'unknown-session', `No control session ${String(name)} on this connection.`);
    return send(ctx.socket, { id, result: {} });
  }
  if (method.startsWith('device-host.input.')) {
    const inputMethod = method.slice('device-host.'.length) as (typeof INPUT_METHODS)[number];
    return input(ctx, id, inputMethod, raw, session);
  }
  if (method === 'device-host.runtime.install') {
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    ctx.socket.once('close', cancel);
    try {
      const answer = await ctx.hostedDevices.installRuntime(session.id, raw, cancellation.signal);
      return send(ctx.socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    } finally {
      ctx.socket.off('close', cancel);
    }
  }
  const answer =
    method === 'device-host.offer'
      ? await ctx.hostedDevices.offer(session.id, raw)
      : method === 'device-host.reserve'
        ? await ctx.hostedDevices.reserve(session.id, raw)
        : method === 'device-host.attach'
          ? ctx.hostedDevices.attach(session.id, raw)
          : method === 'device-host.stop'
            ? ctx.hostedDevices.stop(session.id, raw)
            : method === 'device-host.app.offer'
              ? ctx.hostedDevices.appOffer(session.id, raw, ctx.runId)
              : method === 'device-host.app.chunk'
                ? await ctx.hostedDevices.appChunk(session.id, raw)
                : method === 'device-host.app.handoff'
                  ? await ctx.hostedDevices.appHandoff(session.id, raw)
                  : method === 'device-host.app.launch'
                    ? ctx.hostedDevices.appLaunch(session.id, raw)
                    : method === 'device-host.app.attach'
                      ? ctx.hostedDevices.appAttach(session.id, raw)
                      : method === 'device-host.app.state'
                        ? await ctx.hostedDevices.appState(session.id, raw)
                        : method === 'device-host.logs.query'
                          ? await ctx.hostedDevices.logsQuery(session.id, raw)
                          : method === 'device-host.metro.open'
                            ? await ctx.hostedDevices.metroOpen(session.id, raw)
                            : method === 'device-host.metro.ports'
                              ? await ctx.hostedDevices.metroPorts(session.id, raw)
                              : method === 'device-host.reverse.set'
                                ? await ctx.hostedDevices.reverseSet(session.id, raw)
                                : await ctx.hostedDevices.metroClose(session.id, raw);
  return send(ctx.socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
}
