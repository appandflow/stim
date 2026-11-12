import {
  registryWatch,
  fakeTailscale,
  root,
  calls,
  workspace,
  server,
  pair,
  returning,
  until,
  stimCalls,
  authed,
  liveLogFixture,
  forgetServer,
} from './server-harness.ts';
import assert from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttp2Server, type ServerHttp2Stream } from 'node:http2';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { isJsonObject, loadConfig } from '@stim-cli/core/state';
import { type ServerMessage, type MachineEvent } from '../src/protocol.ts';
import { readAudit } from '../src/actions.ts';
import { capabilitiesFor, grantDevice } from '../src/registry.ts';
import { type Client } from './noise-client.ts';
import { workspaceStateDir, withDirLockTransaction } from '@stim-cli/core';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { readPid } from './pid-file.ts';
import {
  jpeg,
  statusPayload,
  statusWith,
  OWNED_SIM,
  OWNED_WEB,
  toolCalls,
  startWithTools,
  toolRuns,
  fakeHelper,
  helperRuns,
  OWNED_EMULATOR,
  startControl,
  lockCalls,
  controlLease,
  leasedPhone,
} from './server-frames-harness.ts';

describe('frames.subscribe', () => {
  test.skipIf(!fakeTailscale)('tells status subscribers which device leases it holds for phones', async () => {
    const port = await startControl();
    const client = await authed(port, true);
    const watcher = await authed(port, true);
    await watcher.request('machine.subscribe');
    expect(((await watcher.next()) as MachineEvent).ownLeases).toBeUndefined();
    const begun = await client.request('control.begin', { workspace, platform: 'ios' });
    if (!('result' in begun)) throw new Error(JSON.stringify(begun));
    await until(() => lockCalls().length === 1);
    await watcher.request('machine.subscribe');
    const event = (await watcher.next()) as MachineEvent;
    expect(event.ownLeases).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\dT/)]);
    await client.request('control.end', { session: (begun.result as { session: string }).session });
  });

  test.skipIf(!fakeTailscale)('types and presses buttons on an emulator with adb', async () => {
    const port = await startControl();
    const client = await authed(port, true);
    const begun = await client.request('control.begin', { workspace, platform: 'android' });
    const { session } = (begun as { result: { session: string } }).result;
    expect(await client.request('input.text', { session, text: "it's ok\b" })).toMatchObject({ result: {} });
    expect(await client.request('input.button', { session, button: 'app-switch' })).toMatchObject({ result: {} });
    expect(
      toolRuns()
        .filter((run) => run.tool === 'adb')
        .map((run) => run.args),
    ).toEqual([
      ['-s', 'emulator-5554', 'shell', 'input', 'text', "'it'\\''s%sok'"],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_DEL'],
      ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH'],
    ]);
  });

  test.skipIf(!fakeTailscale)(
    'types and presses buttons through the helper on an emulator with a hardware keyboard',
    async () => {
      const port = await startControl({ FAKE_HELPER_KEYBOARD: 'yes' });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'android' });
      const { session } = (begun as { result: { session: string } }).result;
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.text', { session, text: "it's ok\b" })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'app-switch' })).toMatchObject({ result: {} });
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs.slice(1)).toEqual([
        { input: 'text', text: "it's ok\b" },
        { input: 'button', button: 'app-switch' },
      ]);
      expect(toolRuns().filter((run) => run.tool === 'adb')).toEqual([]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'drives the owned Chrome page through the helper without a device lease',
    async () => {
      const port = await startControl({ FAKE_STIM_PAYLOADS: statusWith({ web: OWNED_WEB }) });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'web' });
      expect(begun).toMatchObject({ result: { platform: 'web', lease: null, postures: [] } });
      const { session } = (begun as { result: { session: string } }).result;
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.5, y: 0.5 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.text', { session, text: 'hi\n' })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'back' })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'home' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('input.rotate', { session, direction: 'left' })).toMatchObject({
        error: { code: 'bad-request', message: 'A web page does not rotate or fold.' },
      });
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args).toEqual(['web', 'http://127.0.0.1:8900', '4242', 'PAGE-1']);
      expect(helperRuns()[0]!.configs.slice(1)).toEqual([
        { input: 'touch', phase: 'down', x: 0.5, y: 0.5, display: 0 },
        { input: 'text', text: 'hi\n' },
        { input: 'button', button: 'back' },
        { input: 'touch', phase: 'up', x: 0.5, y: 0.5, display: 0 },
      ]);
      expect(lockCalls()).toEqual([]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('controls a page that another DevTools client drives', async () => {
    const driven = {
      ...OWNED_WEB,
      activity: { state: 'driven', driver: { tool: 'playwright', pid: 77, since: null }, basis: ['cdp-client'] },
    };
    const port = await startControl({ FAKE_STIM_PAYLOADS: statusWith({ web: driven }) });
    const client = await authed(port, true);
    expect(await client.request('control.begin', { workspace, platform: 'web' })).toMatchObject({
      result: { platform: 'web' },
    });
  });

  test.skipIf(!fakeTailscale)(
    'folds an iPhone Duo with sim-fold only when its frames show the other posture',
    async () => {
      const port = await startControl(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-app (iPhone Duo 27.1)' } }),
          FAKE_HELPER_DISPLAYS: '[0]',
        },
        { shapeChangesPerSecond: 100 },
      );
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      const { session, postures } = (begun as { result: { session: string; postures: string[] } }).result;
      expect(postures).toEqual(['folded', 'unfolded']);
      expect(await client.request('input.rotate', { session, direction: 'left' })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.posture', { session, posture: 'unfolded' })).toMatchObject({
        error: { code: 'action-failed' },
      });
      const viewer = await authed(port);
      await viewer.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await viewer.next()).toMatchObject({ event: 'frame', posture: 'folded' });
      expect(await client.request('input.posture', { session, posture: 'folded' })).toMatchObject({ result: {} });
      expect(await client.request('input.posture', { session, posture: 'half-open' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      const spawns = () => toolRuns().filter((run) => run.args[1] === 'spawn');
      expect(spawns()).toEqual([]);
      expect(await client.request('input.posture', { session, posture: 'unfolded' })).toMatchObject({ result: {} });
      expect(spawns()).toEqual([{ tool: 'xcrun', args: ['simctl', 'spawn', 'SIM-1', join(root, 'sim-fold')] }]);
      expect(await client.request('input.posture', { session, posture: 'unfolded' })).toMatchObject({ result: {} });
      expect(spawns()).toHaveLength(1);
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.25, y: 0.75 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.touch', { session, phase: 'up', x: 0.25, y: 0.75, display: 0 })).toMatchObject(
        { result: {} },
      );
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      viewer.socket.close();
      await until(() => helperRuns().length > 0);
      expect(helperRuns().flatMap((run) => run.configs.filter((line) => 'input' in line))).toEqual([
        { input: 'rotate', direction: 'left' },
        { input: 'touch', phase: 'down', x: 0.25, y: 0.75, display: 1 },
        { input: 'touch', phase: 'up', x: 0.25, y: 0.75, display: 0 },
        { input: 'duo-release' },
      ]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'ends a hung fold at its timeout while a grandchild still holds its output',
    async () => {
      const grandchild = join(root, 'grandchild.pid');
      const port = await startControl(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-app (iPhone Duo 27.1)' } }),
          FAKE_HELPER_DISPLAYS: '[0]',
          FAKE_FOLD_GRANDCHILD: grandchild,
        },
        { shapeChangesPerSecond: 100, foldTimeoutMs: 500 },
      );
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      const { session } = (begun as { result: { session: string } }).result;
      const viewer = await authed(port);
      await viewer.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await viewer.next()).toMatchObject({ event: 'frame', posture: 'folded' });
      try {
        expect(await client.request('input.posture', { session, posture: 'unfolded' })).toMatchObject({
          error: { code: 'action-failed', message: 'sim-fold did not finish within 0.5 s.' },
        });
        await until(() => existsSync(grandchild));
        const grandchildPid = await readPid(grandchild);
        expect(() => process.kill(grandchildPid, 0)).not.toThrow();
      } finally {
        if (existsSync(grandchild)) process.kill(await readPid(grandchild), 'SIGKILL');
      }
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'moves the hinge of a foldable emulator and rotates it through the helper',
    async () => {
      const grpc = createHttp2Server();
      grpc.on('stream', (stream: ServerHttp2Stream) => {
        stream.resume();
        stream.on('end', () => {
          const value = Buffer.alloc(4);
          value.writeFloatLE(3);
          const message = Buffer.from([0x08, 0x10, 0x1a, 0x06, 0x0a, 0x04, ...value]);
          const header = Buffer.alloc(5);
          header.writeUInt32BE(message.length, 1);
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end(Buffer.concat([header, message]));
        });
      });
      await new Promise<void>((resolve) => grpc.listen(0, '127.0.0.1', resolve));
      try {
        const port = await startControl();
        const running = join(root, 'fake-home/Library/Caches/TemporaryItems/avd/running');
        mkdirSync(running, { recursive: true });
        writeFileSync(
          join(running, `pid_${process.pid}.ini`),
          `port.serial=5554\ngrpc.port=${(grpc.address() as { port: number }).port}\n`,
        );
        const client = await authed(port, true);
        const begun = await client.request('control.begin', { workspace, platform: 'android' });
        const { session, postures } = (begun as { result: { session: string; postures: string[] } }).result;
        expect(postures).toEqual(['folded', 'half-open', 'unfolded']);
        await until(() => existsSync(`${toolCalls}.started`));
        expect(await client.request('input.posture', { session, posture: 'half-open' })).toMatchObject({ result: {} });
        expect(await client.request('input.rotate', { session, direction: 'right' })).toMatchObject({ result: {} });
        expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
        await until(() => helperRuns().length === 1);
        expect(helperRuns()[0]!.configs.slice(1)).toEqual([
          { input: 'posture', posture: 'half-open' },
          { input: 'rotate', direction: 'right' },
        ]);
        expect(toolRuns().filter((run) => run.tool === 'adb')).toEqual([]);
      } finally {
        await server?.close();
        forgetServer();
        await new Promise((resolve) => grpc.close(resolve));
      }
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'controls a device an agent drives, keeping the agent lease',
    async () => {
      const since = '2026-09-25T12:00:00.000Z';
      const port = await startControl({
        FAKE_STIM_PAYLOADS: statusWith({
          ios: {
            ...OWNED_SIM,
            activity: { state: 'driven', driver: { tool: 'agent-device', pid: 42, since }, basis: [] },
          },
        }),
        FAKE_STIM_LOCK_GRANTED: since,
      });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      const { session } = (begun as { result: { session: string } }).result;
      await client.request('control.end', { session });
      await until(() => readAudit().length === 2);
      expect(readAudit().map((record) => [record.action, record.ok])).toEqual([
        ['control.begin', true],
        ['control.end', true],
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(lockCalls()).toEqual(['device lock ios SIM-1 --for 2m --wait 0 --json']);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'lets two clients control a device at once, holding its lease until the last one ends',
    async () => {
      const lease = controlLease(workspace, 'SIM-2', 'ios', 'tablet');
      const kept = controlLease(workspace, 'SIM-1');
      const port = await startControl({
        FAKE_STIM_PAYLOADS: statusWith({
          slots: [{ slot: 'tablet', ios: { ...OWNED_SIM, udid: 'SIM-2' }, android: null }],
        }),
      });
      const first = await authed(port, true);
      const second = await authed(port, true);
      const target = { workspace, platform: 'ios', slot: 'tablet' };
      const begun = await first.request('control.begin', target);
      const { session } = (begun as { result: { session: string } }).result;
      const joined = await second.request('control.begin', target);
      assert(
        'result' in joined && joined.result && 'session' in joined.result && typeof joined.result.session === 'string',
      );
      const other = joined.result.session;
      expect(other).not.toBe(session);
      expect(await first.request('input.text', { session, text: 'a' })).toMatchObject({ result: {} });
      expect(await second.request('input.text', { session: other, text: 'b' })).toMatchObject({ result: {} });
      first.socket.close();
      expect(await second.request('input.text', { session: other, text: 'c' })).toMatchObject({ result: {} });
      expect(existsSync(lease.path)).toBe(true);
      second.socket.close();
      await until(() => !existsSync(lease.path));
      expect(existsSync(kept.path)).toBe(true);
      expect(lockCalls().filter((args) => args.startsWith('device lock'))).toHaveLength(1);
      expect(lockCalls().every((args) => args.startsWith('device lock'))).toBe(true);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'refuses a client without takeOver while another workspace leases the device, though another client took it over',
    async () => {
      const port = await startControl({ FAKE_STIM_LOCK_BUSY: '1' });
      const first = await authed(port, true);
      const second = await authed(port, true);
      const target = { workspace, platform: 'ios' };
      expect(await first.request('control.begin', target)).toMatchObject({ error: { code: 'device-busy' } });
      expect(await first.request('control.begin', { ...target, takeOver: true })).toHaveProperty('result.lease', null);
      expect(await second.request('control.begin', target)).toMatchObject({
        error: { code: 'device-busy', message: expect.stringContaining('Another workspace leases this device') },
      });
      expect(await second.request('control.begin', { ...target, takeOver: true })).toHaveProperty('result.session');
    },
  );

  test.skipIf(!fakeTailscale)(
    'pushes to the phone that controls a device when an agent starts driving it',
    async () => {
      const bodies: { to: string; body: string; data: unknown }[] = [];
      const expo = createHttpServer((request, response) => {
        let text = '';
        request.on('data', (chunk) => (text += chunk));
        request.on('end', () => {
          const messages = request.url?.endsWith('/send') ? (JSON.parse(text) as typeof bodies) : [];
          bodies.push(...messages);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 't' })) }));
        });
      });
      await new Promise<void>((resolve) => expo.listen(0, '127.0.0.1', resolve));
      try {
        const address = expo.address() as { port: number };
        const statusFile = join(root, 'status.json');
        writeFileSync(statusFile, JSON.stringify(statusPayload({ ios: OWNED_SIM })));
        const port = await startControl(
          { FAKE_STIM_STATUS_FILE: statusFile },
          undefined,
          `http://127.0.0.1:${address.port}/push`,
        );
        const first = await authed(port, true);
        const second = await authed(port, true);
        const token = 'ExponentPushToken[first]';
        await first.request('push.register', { token, events: ['control'], ref: 'mac-1' });
        const listed = await first.request('notifications.list');
        expect(listed).toMatchObject({ result: { cursor: 0, notifications: [] } });
        await second.request('notifications.list', { since: 0 });
        await first.request('control.begin', { workspace, platform: 'ios' });
        const driven = {
          ...OWNED_SIM,
          activity: { state: 'driven', driver: { tool: 'agent-device', pid: 42, since: null }, basis: [] },
        };
        writeFileSync(`${statusFile}.next`, JSON.stringify(statusPayload({ ios: driven })));
        renameSync(`${statusFile}.next`, statusFile);
        const body = 'agent-device started driving the iOS device you are controlling';
        await until(() => bodies.some((sent) => sent.body === body));
        expect(bodies.filter((sent) => sent.body === body)).toEqual([
          expect.objectContaining({
            to: token,
            data: {
              ref: 'mac-1',
              notification: expect.any(Number),
              target: 'device',
              path: workspace,
              platform: 'ios',
              slot: 'default',
            },
          }),
        ]);
        const entry = {
          id: `control:${workspace}:ios:default`,
          category: 'control',
          body,
          target: { kind: 'device', path: workspace, platform: 'ios', slot: 'default' },
        };
        const controls = (reply: unknown) => {
          assert(isJsonObject(reply) && isJsonObject(reply.result) && Array.isArray(reply.result.notifications));
          return reply.result.notifications.filter(
            (notification) => isJsonObject(notification) && notification.category === 'control',
          );
        };
        expect(controls(await first.request('notifications.list', { since: 0 }))).toEqual([
          expect.objectContaining(entry),
        ]);
        expect(controls(await second.request('notifications.list', { since: 0 }))).toEqual([]);
        expect(await second.request('notifications.list', { since: -1 })).toMatchObject({
          error: { code: 'bad-request' },
        });
      } finally {
        await new Promise((resolve) => expo.close(resolve));
      }
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('ends an idle session, and caps the input and typing rates', async () => {
    const lease = controlLease(workspace, 'SIM-1');
    const port = await startControl({}, { idleMs: 700, inputPerSecond: 3, textCharsPerSecond: 1 });
    const client = await authed(port, true);
    const begun = await client.request('control.begin', { workspace, platform: 'ios' });
    const { session } = (begun as { result: { session: string } }).result;
    const replies = [];
    for (let i = 0; i < 5; i++)
      replies.push(await client.request('input.touch', { session, phase: 'move', x: 0, y: 0 }));
    expect(replies.filter((reply) => 'error' in reply)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'limit-exceeded' }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: 'limit-exceeded' }) }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await client.request('input.text', { session, text: 'x'.repeat(200) })).toMatchObject({ result: {} });
    expect(await client.request('input.text', { session, text: 'x'.repeat(100) })).toMatchObject({
      error: { code: 'limit-exceeded' },
    });
    expect(await client.next()).toMatchObject({ event: 'control-ended', session, reason: 'idle' });
    await until(() => !existsSync(lease.path));
  });

  test.skipIf(!fakeTailscale)('lets a touch down and up through while moves have drained the input rate', async () => {
    controlLease(workspace, 'SIM-1');
    const port = await startControl({}, { inputPerSecond: 3 });
    const client = await authed(port, true);
    const begun = await client.request('control.begin', { workspace, platform: 'ios' });
    assert('result' in begun && begun.result && 'session' in begun.result && typeof begun.result.session === 'string');
    const { session } = begun.result;
    const touch = (phase: string) => client.request('input.touch', { session, phase, x: 0, y: 0 });
    await touch('down');
    const moves = [];
    for (let i = 0; i < 8; i++) moves.push(await touch('move'));
    expect(moves.filter((reply) => 'error' in reply).length).toBeGreaterThan(0);

    expect(await touch('up')).toMatchObject({ result: {} });
    expect(await touch('down')).toMatchObject({ result: {} });
    expect(await touch('up')).toMatchObject({ result: {} });
  });

  test.each([false, true])(
    'ends a control session with watch events dropped: %s',
    { skip: !fakeTailscale },
    async (dropEvents) => {
      const lease = controlLease(workspace, 'SIM-1');
      registryWatch.dropEvents = dropEvents;
      const port = await startControl();
      const { id, keyPair } = await pair(port, undefined, true);
      const client = await returning(port, keyPair);
      const reader = await authed(port);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      const { session } = (begun as { result: { session: string } }).result;
      let entered = () => {};
      const locked = new Promise<void>((resolve) => (entered = resolve));
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const barrier = withDirLockTransaction(lease.lock, () => {
        entered();
        return held;
      });
      let closing: Promise<void> | undefined;
      try {
        await locked;
        await until(() => existsSync(`${toolCalls}.started`));
        grantDevice(id, capabilitiesFor(false));
        expect(await client.next()).toMatchObject({ event: 'control-ended', session, reason: 'forbidden' });
        expect(await reader.request('machine.get')).toMatchObject({ result: expect.any(Object) });
        expect(existsSync(lease.path)).toBe(true);
        let closed = false;
        closing = server!.close().then(() => {
          closed = true;
          return undefined;
        });
        await Promise.all([client.closed, reader.closed]);
        await until(() => helperRuns().length === 1);
        expect(closed).toBe(false);
        release();
        await barrier;
        await closing;
        forgetServer();
        expect(existsSync(lease.path)).toBe(false);
        expect(readClaimSet(`${lease.lock}.claims`)).toMatchObject({ live: [], unresolved: [], orphans: [] });
        expect(lockCalls().every((args) => args.startsWith('device lock'))).toBe(true);
      } finally {
        release();
        await barrier;
        await closing;
      }
    },
  );

  test.skipIf(!fakeTailscale)(
    'streams the phone its workspace leases through the adb helper, and never another workspace or an emulator',
    async () => {
      const port = await startControl({
        FAKE_STIM_PAYLOADS: leasedPhone([
          { id: 'R58M1234ABC' },
          { id: 'OTHERPHONE', holder: '/work/other', slot: 'tablet' },
          { id: 'emulator-5556', slot: 'tablet', holder: workspace },
          { id: 'EXPIREDPHONE', slot: 'old', expired: true },
        ]),
      });
      const client = await authed(port);
      const subscribed = await client.request('frames.subscribe', { workspace, platform: 'android', physical: true });
      expect(subscribed).toMatchObject({ result: { subscription: expect.any(String) } });
      await until(() => existsSync(`${toolCalls}.started`));
      for (const slot of ['tablet', 'old']) {
        await client.request('frames.subscribe', { workspace, platform: 'android', physical: true, slot });
        expect(await client.next()).toMatchObject({
          event: 'error',
          error: { code: 'frames-failed', message: expect.stringContaining('leases no physical Android device') },
        });
      }
      await server!.close();
      forgetServer();
      await until(() => helperRuns().length === 1);
      const [run] = helperRuns();
      expect(run!.args.slice(0, 2)).toEqual(['android-device', 'R58M1234ABC']);
      expect(run!.args[2]).toBe('adb');
      expect(run!.args[3]).toMatch(/scrcpy\/scrcpy-server$/);
    },
  );

  test.skipIf(!fakeTailscale)(
    'the adb test switch resolves a leased emulator as a phone, and never an iPhone lease on the own simulator',
    async () => {
      const lease = {
        grantedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        mine: false,
        expired: false,
        parsed: true,
        deviceName: null,
        holder: workspace,
      };
      const payload = statusPayload({ ios: OWNED_SIM, android: OWNED_EMULATOR }) as Record<string, unknown>;
      const port = await startControl({
        STIM_SERVER_TEST_ADB_EMULATORS: '1',
        FAKE_STIM_PAYLOADS: JSON.stringify([
          {
            ...payload,
            deviceLeases: [
              { ...lease, path: '/locks/emu', platform: 'android', id: 'emulator-5554' },
              { ...lease, path: '/locks/sim', platform: 'ios', id: 'SIM-1' },
            ],
          },
        ]),
      });
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { code: 'frames-failed', message: expect.stringContaining('leases no physical iPhone') },
      });
      await client.request('frames.subscribe', { workspace, platform: 'android', physical: true });
      await until(() => existsSync(`${toolCalls}.started`));
      await server!.close();
      forgetServer();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args.slice(0, 2)).toEqual(['android-device', 'emulator-5554']);
    },
  );

  test.skipIf(!fakeTailscale)(
    'controls a phone only under the lease its workspace holds, and never takes or releases that lease',
    async () => {
      const port = await startControl({
        FAKE_STIM_PAYLOADS: leasedPhone([{ id: 'R58M1234ABC' }, { id: 'OTHERPHONE', slot: 'tablet', holder: '/w/b' }]),
      });
      const client = await authed(port, true);
      for (const takeOver of [false, true]) {
        expect(
          await client.request('control.begin', {
            workspace,
            platform: 'android',
            physical: true,
            slot: 'tablet',
            takeOver,
          }),
        ).toMatchObject({
          error: { code: 'action-failed', message: expect.stringContaining('leases no physical Android device') },
        });
      }
      const begun = await client.request('control.begin', { workspace, platform: 'android', physical: true });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session, lease, postures } = begun.result as {
        session: string;
        lease: { expiresAt: string };
        postures: [];
      };
      expect(lease.expiresAt).toEqual(expect.any(String));
      expect(postures).toEqual([]);
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.5, y: 0.5 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.text', { session, text: 'hi\n' })).toMatchObject({ result: {} });
      for (const [method, params] of [
        ['input.rotate', { direction: 'left' }],
        ['input.posture', { posture: 'folded' }],
      ] as const) {
        expect(await client.request(method, { session, ...params })).toMatchObject({
          error: { code: 'bad-request', message: 'A physical device rotates and folds only in hand.' },
        });
      }
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await server!.close();
      forgetServer();
      expect(lockCalls()).toEqual([]);
      await until(() => helperRuns().length === 1);
      const run = helperRuns().find((entry) => entry.args[0] === 'android-device');
      expect(run?.configs.slice(1)).toEqual([
        { input: 'touch', phase: 'down', x: 0.5, y: 0.5, display: 0 },
        { input: 'text', text: 'hi\n' },
        { input: 'touch', phase: 'up', x: 0.5, y: 0.5, display: 0 },
      ]);
    },
  );

  test.skipIf(!fakeTailscale)(
    'ends control of a phone once its lease expires, without another status update',
    async () => {
      const port = await startControl({
        FAKE_STIM_PAYLOADS: leasedPhone([{ id: 'R58M1234ABC', expiresAt: new Date(Date.now() + 4000).toISOString() }]),
      });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'android', physical: true });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session } = begun.result as { session: string };
      await new Promise((resolve) => setTimeout(resolve, 4100));
      const replies = [
        await client.request('input.touch', { session, phase: 'down', x: 0.5, y: 0.5 }),
        await client.next(),
      ];
      expect(replies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'control-ended', session, reason: 'device-gone' }),
          expect.objectContaining({ error: expect.objectContaining({ code: 'unknown-session' }) }),
        ]),
      );
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('refuses frame rates and sizes outside the protocol range', async () => {
    const port = await startWithTools({ FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]' });
    const client = await authed(port);
    for (const params of [{ fps: 0 }, { fps: 31 }, { fps: 2.5 }, { maxEdge: 100 }, { maxEdge: 4096 }]) {
      expect(await client.request('frames.subscribe', { workspace, platform: 'ios', ...params })).toMatchObject({
        error: { code: 'bad-request' },
      });
    }
  });

  describe.skipIf(!fakeTailscale)('emulator screenshots over gRPC', () => {
    test.each([
      { device: 'a phone', posture: 0, folded: false, refused: false, reported: undefined },
      { device: 'a folded foldable', posture: 1, folded: true, refused: false, reported: 'folded' },
      { device: 'an unfolded foldable', posture: 3, folded: false, refused: false, reported: 'unfolded' },
      { device: 'an emulator that refuses POSTURE', posture: 3, folded: false, refused: true, reported: undefined },
    ])(
      'reads an emulator screenshot over gRPC with the discovery token and converts it to JPEG: $device',
      async ({ posture, folded, refused, reported }) => {
        const png = Buffer.from('not really a png');
        const requests: { path: string; authorization: string | undefined; body: Buffer }[] = [];
        const grpc = createHttp2Server();
        grpc.on('stream', (stream: ServerHttp2Stream, headers) => {
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            requests.push({
              path: String(headers[':path']),
              authorization: headers.authorization,
              body: Buffer.concat(chunks),
            });
            const value = Buffer.alloc(4);
            value.writeFloatLE(posture);
            const format = Buffer.from([
              0x18,
              0xa0,
              0x02,
              0x20,
              0xc0,
              0x04,
              ...(folded ? [0x3a, 0x06, 0x08, 0xb8, 0x08, 0x10, 0xac, 0x10] : []),
            ]);
            const physical = String(headers[':path']).endsWith('/getPhysicalModel');
            const message = physical
              ? Buffer.from([0x08, 0x10, 0x1a, 0x06, 0x0a, 0x04, ...value])
              : Buffer.concat([Buffer.from([0x0a, format.length]), format, Buffer.from([0x22, png.length]), png]);
            const frameHeader = Buffer.alloc(5);
            frameHeader.writeUInt32BE(message.length, 1);
            stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
            stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': physical && refused ? '12' : '0' }));
            stream.end(Buffer.concat([frameHeader, message]));
          });
        });
        await new Promise<void>((resolve) => grpc.listen(0, '127.0.0.1', resolve));
        const grpcPort = (grpc.address() as { port: number }).port;
        const home = join(root, 'fake-home');
        const running = join(home, 'Library/Caches/TemporaryItems/avd/running');
        mkdirSync(running, { recursive: true });
        writeFileSync(
          join(running, `pid_${process.pid}.ini`),
          `port.serial=5554\ngrpc.port=${grpcPort}\ngrpc.token=secret-token\n`,
        );
        const converted = jpeg(288, 640, 'android');
        try {
          const port = await startWithTools({
            HOME: home,
            FAKE_STIM_PAYLOADS: JSON.stringify([
              statusPayload({
                android: { name: 'stim-app', owned: true, physical: false, serial: 'emulator-5554', state: 'detected' },
              }),
              statusPayload({
                android: { name: 'stim-app', owned: true, physical: false, serial: null, state: 'unknown' },
              }),
            ]),
            FAKE_FRAMES: '[]',
            FAKE_SIPS_JPEG: converted.toString('base64'),
          });
          const client = await authed(port);
          await client.request('frames.subscribe', { workspace, platform: 'android' });
          const frame = await client.next();
          expect(frame).toMatchObject({
            event: 'frame',
            platform: 'android',
            slot: 'default',
            mime: 'image/jpeg',
            width: 288,
            height: 640,
            data: converted.toString('base64'),
          });
          expect((frame as { posture?: string }).posture).toBe(reported);
          expect(requests.slice(0, 2)).toMatchObject([
            {
              path: '/android.emulation.control.EmulatorController/getPhysicalModel',
              authorization: 'Bearer secret-token',
            },
            {
              path: '/android.emulation.control.EmulatorController/getScreenshot',
              authorization: 'Bearer secret-token',
            },
          ]);
          expect([...requests[0]!.body]).toEqual([0, 0, 0, 0, 2, 0x08, 0x10]);
          expect([...requests[1]!.body]).toEqual([0, 0, 0, 0, 6, 0x18, 0x80, 0x0a, 0x20, 0x80, 0x0a]);
          const seen = requests.length;
          await until(() => requests.length > seen + 1);
          expect(requests.filter((request) => request.path.endsWith('/getPhysicalModel'))).toHaveLength(1);
          expect(client.socket.readyState).toBe(WebSocket.OPEN);
          const [sips] = toolRuns();
          expect(sips?.tool).toBe('sips');
          expect(sips?.args.slice(0, 4)).toEqual(['-s', 'format', 'jpeg', '-s']);
          expect(readFileSync(sips!.args.at(-3)!)).toEqual(png);
        } finally {
          await server?.close();
          forgetServer();
          await new Promise((resolve) => grpc.close(resolve));
        }
      },
    );
  });

  describe('recording', () => {
    const DRIVEN = { state: 'driven', driver: { tool: 'agent-device', pid: 1, since: null }, basis: [] };
    const RECORDING = { record: true, recordLimits: { segmentMs: 100 } };

    function deviceDir(): string {
      return join(workspaceStateDir(workspace), 'recordings', 'ios-default');
    }

    function registerWorkspaceDir(): void {
      mkdirSync(workspaceStateDir(workspace), { recursive: true });
      writeFileSync(join(workspaceStateDir(workspace), 'workspace.json'), JSON.stringify({ projectRoot: workspace }));
    }

    function segments(): { name: string; units: { keyframe: boolean; at: number }[] }[] {
      if (!existsSync(deviceDir())) return [];
      return readdirSync(deviceDir())
        .toSorted()
        .map((name) => {
          const bytes = readFileSync(join(deviceDir(), name));
          const units = [];
          for (let at = 0; at + 4 <= bytes.length; at += 4 + bytes.readUInt32BE(at)) {
            units.push({ keyframe: (bytes[at + 4]! & 1) !== 0, at: bytes.readDoubleBE(at + 5) });
          }
          return { name, units };
        });
    }

    const closed = () => segments().filter(({ name }) => name.endsWith('.seg'));

    test.skipIf(!fakeTailscale)(
      'records a driven simulator nobody watches into segments that start at a keyframe',
      async () => {
        registerWorkspaceDir();
        await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          RECORDING,
        );
        await until(() => closed().length >= 2);
        for (const { name, units } of closed()) {
          const [first, last] = name.replace('.seg', '').split('-').map(Number);
          expect(units[0]!.keyframe).toBe(true);
          expect(Math.floor(units[0]!.at)).toBe(first);
          expect(units.at(-1)!.at).toBeLessThanOrEqual(last!);
        }
        await server!.close();
        forgetServer();
        expect(segments().every(({ name }) => name.endsWith('.seg'))).toBe(true);
        const [run] = helperRuns();
        expect(run!.args).toEqual(['ios', 'SIM-1']);
        expect(run!.configs[0]).toEqual({
          fps: 10,
          maxEdge: 720,
          jpeg: false,
          video: false,
          bitrate: 3_000_000,
          record: { maxEdge: 720, fps: 10, bitrate: 1_000_000 },
        });
      },
      10_000,
    );

    test.skipIf(!fakeTailscale)('records an idle device only while a client watches it', async () => {
      registerWorkspaceDir();
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM, recording: { enabled: true } }),
          FAKE_HELPER_INTERVAL_MS: '10',
        },
        undefined,
        fakeHelper(),
        RECORDING,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(deviceDir())).toBe(false);
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], fps: 30 });
      await until(() => closed().length >= 1);
      client.socket.close();
      await until(() => segments().length > 0 && segments().every(({ name }) => name.endsWith('.seg')));
      const count = segments().length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(segments()).toHaveLength(count);
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs).toContainEqual(
        expect.objectContaining({ fps: 30, video: true, record: { maxEdge: 720, fps: 10, bitrate: 1_000_000 } }),
      );
    });

    test.skipIf(!fakeTailscale)(
      'stops capturing and deletes the recordings once status shows recording off',
      async () => {
        registerWorkspaceDir();
        const on = statusPayload({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } });
        const off = statusPayload({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: false } });
        await startWithTools(
          {
            FAKE_STIM_PAYLOADS: JSON.stringify([...Array.from({ length: 60 }, () => on), off]),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          RECORDING,
        );
        await until(() => closed().length >= 1);
        await until(() => !existsSync(join(workspaceStateDir(workspace), 'recordings')));
        await until(() => helperRuns().length === 1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(existsSync(join(workspaceStateDir(workspace), 'recordings'))).toBe(false);
      },
      10_000,
    );

    test.skipIf(!fakeTailscale)('keeps only the last footage of each device', async () => {
      registerWorkspaceDir();
      const started = Date.now();
      await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
          FAKE_HELPER_INTERVAL_MS: '10',
        },
        undefined,
        fakeHelper(),
        { record: true, recordLimits: { segmentMs: 50, footageMs: 300, pruneMs: 100 } },
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const kept = closed().map(({ name }) => name.replace('.seg', '').split('-').map(Number) as [number, number]);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.reduce((sum, [first, last]) => sum + last - first, 0)).toBeLessThanOrEqual(500);
      expect(kept[0]![0]).toBeGreaterThan(started + 500);
    });

    test.skipIf(!fakeTailscale)(
      'asks for a keyframe once a segment is due, so a screen that does not change still gets segments',
      async () => {
        registerWorkspaceDir();
        await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
            FAKE_HELPER_STATIC: '1',
          },
          undefined,
          fakeHelper(),
          RECORDING,
        );
        await until(() => closed().length >= 1);
      },
      10_000,
    );

    test.skipIf(!fakeTailscale)(
      'records nothing while another stim-server holds the recording claim, and takes over when it frees',
      async () => {
        registerWorkspaceDir();
        const other = tryAcquireClaim({
          root: join(process.env.STIM_HOME!, 'server', 'recorder'),
          mode: 'exclusive',
        }).acquired!;
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          { record: true, recordLimits: { segmentMs: 100, pruneMs: 100 } },
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(existsSync(deviceDir())).toBe(false);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('another stim-server'));
        error.mockRestore();
        releaseClaim(other);
        await until(() => closed().length >= 1);
      },
      10_000,
    );

    describe('replay', () => {
      const BASE = Date.now() - 60_000;
      const STOPPED_SIM = { ...OWNED_SIM, state: 'Shutdown' };

      /** Writes a segment of units every 100 ms from `start`, a keyframe every 5 units. */
      function footage(first: number, count: number): void {
        mkdirSync(deviceDir(), { recursive: true });
        const units = Array.from({ length: count }, (_, i) => {
          const header = Buffer.alloc(17);
          header.writeUInt32BE(13 + 5, 0);
          header.writeUInt8(i % 5 === 0 ? 1 : 0, 4);
          header.writeDoubleBE(first + i * 100, 5);
          header.writeUInt16BE(330, 13);
          header.writeUInt16BE(720, 15);
          return Buffer.concat([header, Buffer.from([0, 0, 0, 1, i])]);
        });
        writeFileSync(join(deviceDir(), `${first}-${first + (count - 1) * 100}.seg`), Buffer.concat(units));
      }

      const packetAt = (message: ServerMessage) => (message as unknown as { binary: Buffer }).binary.readDoubleBE(8);

      async function untilMessage(client: Client, done: (message: ServerMessage) => boolean): Promise<ServerMessage[]> {
        const seen: ServerMessage[] = [];
        for (;;) {
          const message = await client.next();
          seen.push(message);
          if (done(message)) return seen;
        }
      }

      test.skipIf(!fakeTailscale)(
        "replays a stopped device's footage from a time, plays it to the end, and cannot go live",
        async () => {
          registerWorkspaceDir();
          footage(BASE, 20);
          footage(BASE + 30_000, 5);
          const port = await startWithTools(
            { FAKE_STIM_PAYLOADS: statusWith({ ios: STOPPED_SIM, recording: { enabled: true } }) },
            undefined,
            fakeHelper(),
            { record: true },
          );
          const client = await authed(port);
          expect(
            await client.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], at: BASE + 730 }),
          ).toMatchObject({ result: { subscription: 's1', video: 'h264' } });
          const shown = await untilMessage(
            client,
            (message) => 'binary' in message && packetAt(message) === BASE + 700,
          );
          expect(shown.map(packetAt)).toEqual([BASE + 500, BASE + 600, BASE + 700]);

          client.socket.send(
            JSON.stringify({ id: 50, method: 'frames.seek', params: { subscription: 's1', at: BASE + 1500, rate: 2 } }),
          );
          const played = await untilMessage(
            client,
            (message) => 'event' in message && message.event === 'replay-ended',
          );
          expect(played).toContainEqual({ id: 50, result: { at: BASE + 1500 } });
          expect(played.filter((message) => 'binary' in message).map(packetAt)).toEqual([
            ...[1500, 1600, 1700, 1800, 1900].map((offset) => BASE + offset),
            ...[0, 100, 200, 300, 400].map((offset) => BASE + 30_000 + offset),
          ]);
          expect(played.at(-1)).toEqual({ event: 'replay-ended', subscription: 's1', at: BASE + 30_400 });

          client.socket.send(
            JSON.stringify({
              id: 51,
              method: 'frames.seek',
              params: { subscription: 's1', at: BASE + 30_400, rate: 2 },
            }),
          );
          const atEnd = await untilMessage(client, (message) => 'event' in message && message.event === 'replay-ended');
          expect(atEnd.filter((message) => !('binary' in message))).toEqual([
            { id: 51, result: { at: BASE + 30_400 } },
            { event: 'replay-ended', subscription: 's1', at: BASE + 30_400 },
          ]);

          expect(await client.request('frames.live', { subscription: 's1' })).toMatchObject({
            error: { code: 'frames-failed', message: expect.stringContaining('not booted') },
          });
          client.socket.send(
            JSON.stringify({
              id: 70,
              method: 'frames.seek',
              params: { subscription: 's1', at: BASE + 60_000, rate: 0 },
            }),
          );
          const past = await untilMessage(client, (message) => 'id' in message && message.id === 70);
          expect(past.at(-1)).toEqual({ id: 70, result: { at: BASE + 30_400 } });
          expect(
            await client.request('frames.subscribe', {
              workspace,
              platform: 'ios',
              slot: '../../other',
              video: ['h264'],
              at: BASE,
            }),
          ).toMatchObject({ error: { code: 'bad-request' } });
          expect(helperRuns()).toEqual([]);
        },
        10_000,
      );

      test.skipIf(!fakeTailscale)('seeks a live subscription into the footage and returns to live', async () => {
        registerWorkspaceDir();
        footage(BASE, 10);
        const port = await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          { record: true },
        );
        const client = await authed(port);
        await client.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], fps: 30 });
        await untilMessage(client, (message) => 'binary' in message);
        client.socket.send(
          JSON.stringify({ id: 60, method: 'frames.seek', params: { subscription: 's1', at: BASE + 200, rate: 0 } }),
        );
        const seeked = await untilMessage(client, (message) => 'id' in message && message.id === 60);
        expect(seeked.at(-1)).toEqual({ id: 60, result: { at: BASE + 200 } });
        expect(
          seeked
            .filter((message) => 'binary' in message)
            .map(packetAt)
            .slice(-3),
        ).toEqual([BASE, BASE + 100, BASE + 200]);
        client.socket.send(JSON.stringify({ id: 61, method: 'frames.live', params: { subscription: 's1' } }));
        expect((await untilMessage(client, (message) => 'id' in message && message.id === 61)).at(-1)).toEqual({
          id: 61,
          result: {},
        });
        const live = await untilMessage(client, (message) => 'binary' in message);
        expect(packetAt(live.at(-1)!)).toBeLessThan(1_800_000_000_000);
        expect(packetAt(live.at(-1)!)).toBeGreaterThan(1_758_000_000_000);
      });

      test.skipIf(!fakeTailscale)('a seek on a device with no recording stays live', async () => {
        registerWorkspaceDir();
        const port = await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM, recording: { enabled: true } }),
            FAKE_HELPER_INTERVAL_MS: '10',
          },
          undefined,
          fakeHelper(),
          { record: false },
        );
        const client = await authed(port);
        await client.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], fps: 30 });
        await untilMessage(client, (message) => 'binary' in message);
        client.socket.send(
          JSON.stringify({ id: 80, method: 'frames.seek', params: { subscription: 's1', at: BASE, rate: 0 } }),
        );
        const refused = await untilMessage(client, (message) => 'id' in message && message.id === 80);
        expect(refused.at(-1)).toMatchObject({ id: 80, error: { code: 'no-recording' } });
        const next = await untilMessage(client, (message) => 'binary' in message);
        expect(packetAt(next.at(-1)!)).toBeLessThan(1_760_000_000_000);
      });

      test.skipIf(!fakeTailscale)(
        'serves the keyframe of the segment covering a time, a few reads at a time',
        async () => {
          registerWorkspaceDir();
          footage(BASE, 10);
          footage(BASE + 30_000, 10);
          const port = await startWithTools(
            { FAKE_STIM_PAYLOADS: statusWith({ ios: STOPPED_SIM, recording: { enabled: true } }) },
            undefined,
            fakeHelper(),
            { record: true },
          );
          const client = await authed(port);
          const keyframe = (at: unknown, platform = 'ios') =>
            client.request('replay.keyframe', { workspace, platform, at });

          expect(await keyframe(BASE + 850)).toMatchObject({
            result: {
              start: BASE,
              end: BASE + 900,
              at: BASE,
              width: 330,
              height: 720,
              data: Buffer.from([0, 0, 0, 1, 0]).toString('base64'),
            },
          });
          expect(await keyframe(BASE + 10_000)).toMatchObject({ result: { start: BASE + 30_000, at: BASE + 30_000 } });
          expect(await keyframe(BASE, 'android')).toMatchObject({ error: { code: 'no-recording' } });
          expect(await keyframe('soon')).toMatchObject({ error: { code: 'bad-request' } });

          const burst = Array.from({ length: 20 }, () => keyframe(BASE));
          const answers = await Promise.all(burst);
          const limited = answers.filter((answer) => 'error' in answer);
          expect(limited.length).toBeGreaterThan(0);
          expect(limited).toEqual(
            limited.map(() => expect.objectContaining({ error: expect.objectContaining({ code: 'limit-exceeded' }) })),
          );
          expect(await keyframe(BASE)).toMatchObject({ result: { at: BASE } });
        },
      );

      test.skipIf(!fakeTailscale)('lists the recorded spans and the markers of the device', async () => {
        registerWorkspaceDir();
        footage(BASE, 10);
        footage(BASE + 30_000, 10);
        const logged = [
          { ts: BASE + 300, src: 'agent', event: 'agent_action', platform: 'ios', command: 'press', msg: 'press @e3' },
          { ts: BASE + 400, src: 'agent', event: 'agent_action', platform: 'android', command: 'press', msg: 'other' },
          { ts: BASE + 30_500, src: 'build', level: 'error', msg: 'Compile failed' },
        ];
        liveLogFixture(logged);
        const port = await startWithTools(
          {
            FAKE_STIM_PAYLOADS: statusWith({ ios: STOPPED_SIM, recording: { enabled: true } }),
            FAKE_STIM_RECORDS: JSON.stringify(logged),
            FAKE_STIM_BY_SOURCE: '1',
          },
          undefined,
          fakeHelper(),
          { record: true },
        );
        const client = await authed(port);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await client.request('replay.range', { workspace, platform: 'ios' })).toEqual({
          id: 2,
          result: {
            enabled: true,
            recording: false,
            spans: [
              { start: BASE, end: BASE + 900 },
              { start: BASE + 30_000, end: BASE + 30_900 },
            ],
            markers: [
              { at: BASE + 300, kind: 'action', command: 'press', label: 'press @e3' },
              { at: BASE + 30_500, kind: 'error', label: 'Compile failed' },
            ],
          },
        });
        const logs = readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line.includes('"logs'));
        expect(logs).toEqual([]);
        expect(await client.request('replay.range', { workspace, platform: 'android' })).toMatchObject({
          result: { spans: [], markers: [] },
        });
      });
    });

    function holdRecordingDeletion(recordings: string) {
      let entered = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const remove = fsPromises.rm;
      const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
        if (path === recordings) {
          entered();
          await held;
        }
        return remove(path, options);
      });
      syncBuiltinESMExports();
      return {
        started,
        release,
        restore: () => {
          deletion.mockRestore();
          syncBuiltinESMExports();
        },
      };
    }

    test.skipIf(!fakeTailscale)('turns recording off at machine scope for a device with control only', async () => {
      writeFileSync(join(workspace, 'package.json'), '{}');
      const recordings = join(workspaceStateDir(workspace), 'recordings');
      mkdirSync(recordings, { recursive: true });
      writeFileSync(join(recordings, 'segment'), 'owned recording');
      const port = await startWithTools({ FAKE_STIM_PAYLOADS: '[]' }, undefined, fakeHelper(), { record: true });
      const reader = await authed(port);
      expect(await reader.request('recording.set', { enabled: false })).toMatchObject({ error: { code: 'forbidden' } });
      const controller = await authed(port, true);
      expect(await controller.request('recording.set', { enabled: 'no' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await controller.request('recording.set', { enabled: false })).toMatchObject({
        result: { enabled: false, recordingsDeleted: [workspace] },
      });
      expect(loadConfig()).toMatchObject({ recording: { enabled: false } });
      expect(existsSync(recordings)).toBe(false);
      expect(stimCalls().filter((call) => call.args?.startsWith('settings set'))).toEqual([]);
      expect(readAudit().map((entry) => [entry.action, entry.ok])).toEqual([
        ['recording.set', false],
        ['recording.set', false],
        ['recording.set', true],
      ]);
    });

    test.skipIf(!fakeTailscale)('runs recording.set requests one at a time, so the last one wins', async () => {
      writeFileSync(join(workspace, 'package.json'), '{}');
      const recordings = join(workspaceStateDir(workspace), 'recordings');
      mkdirSync(recordings, { recursive: true });
      writeFileSync(join(recordings, 'segment'), 'owned recording');
      const port = await startWithTools({ FAKE_STIM_PAYLOADS: '[]' }, undefined, fakeHelper(), { record: true });
      const first = await authed(port, true);
      const second = await authed(port, true);
      const deletion = holdRecordingDeletion(recordings);
      const off = first.request('recording.set', { enabled: false });
      let on: ReturnType<typeof second.request> | undefined;
      try {
        await deletion.started;
        on = second.request('recording.set', { enabled: true });
        await second.request('machine.get');
        expect(loadConfig()).toMatchObject({ recording: { enabled: false } });
        expect(existsSync(recordings)).toBe(true);
        deletion.release();
        expect(await off).toMatchObject({ result: { enabled: false, recordingsDeleted: [workspace] } });
        expect(await on).toMatchObject({ result: { enabled: true, recordingsDeleted: [] } });
        expect(loadConfig()).toMatchObject({ recording: { enabled: true } });
        expect(existsSync(recordings)).toBe(false);
        expect(stimCalls().filter((call) => call.args?.startsWith('settings set'))).toEqual([]);
        expect(
          readAudit()
            .filter((entry) => entry.action === 'recording.set')
            .map((entry) => entry.ok),
        ).toEqual([true, true]);
      } finally {
        deletion.release();
        await Promise.allSettled([off, on]);
        deletion.restore();
      }
    });

    test.skipIf(!fakeTailscale)('closes while a recording.set runs and starts none queued behind it', async () => {
      writeFileSync(join(workspace, 'package.json'), '{}');
      const recordings = join(workspaceStateDir(workspace), 'recordings');
      mkdirSync(recordings, { recursive: true });
      writeFileSync(join(recordings, 'segment'), 'owned recording');
      const port = await startWithTools({ FAKE_STIM_PAYLOADS: '[]' }, undefined, fakeHelper(), {
        record: true,
        actionLimits: { timeoutMs: 1000 },
      });
      const first = await authed(port, true);
      const second = await authed(port, true);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deletion = holdRecordingDeletion(recordings);
      let closing: Promise<void> | undefined;
      try {
        first.socket.send(JSON.stringify({ id: 90, method: 'recording.set', params: { enabled: false } }));
        await deletion.started;
        second.socket.send(JSON.stringify({ id: 91, method: 'recording.set', params: { enabled: true } }));
        await second.request('settings.get');
        const timedOut = first.next();
        await vi.advanceTimersByTimeAsync(1000);
        expect(await timedOut).toMatchObject({
          id: 90,
          error: { code: 'action-failed', message: 'stim settings did not finish within 1 s.' },
        });
        expect(loadConfig()).toMatchObject({ recording: { enabled: false } });
        let serverClosed = false;
        closing = server!.close().then(() => {
          serverClosed = true;
          return undefined;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(serverClosed).toBe(false);
        deletion.release();
        await closing;
        forgetServer();
        expect(existsSync(recordings)).toBe(false);
        expect(loadConfig()).toMatchObject({ recording: { enabled: false } });
        expect(stimCalls().filter((call) => call.args?.startsWith('settings set'))).toEqual([]);
        expect(readAudit().filter((entry) => entry.action === 'recording.set')).toEqual([
          expect.objectContaining({
            ok: false,
            error: { code: 'action-failed', message: 'stim settings did not finish within 1 s.' },
          }),
        ]);
      } finally {
        deletion.release();
        await closing;
        deletion.restore();
        vi.useRealTimers();
      }
    });

    test.skipIf(!fakeTailscale)('never fills a workspace directory that has no workspace.json', async () => {
      await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, activity: DRIVEN }, recording: { enabled: true } }),
          FAKE_HELPER_INTERVAL_MS: '10',
        },
        undefined,
        fakeHelper(),
        RECORDING,
      );
      await until(() => existsSync(`${toolCalls}.started`));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(workspaceStateDir(workspace))).toBe(false);
    });
  });
});
