import { fakeTailscale, root, workspace, pair, returning, desktop, alive, until, authed } from './server-harness.ts';
import assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  type StatusPayload,
  readWorkspaceState,
  deviceHostArea,
  deviceHostRoot,
  readViewedDevices,
  isJsonObject,
} from '@stim-cli/core/state';
import { ownedDevice } from '../src/frames.ts';
import { PEER, protocolJsonSchema } from '../src/protocol.ts';
import Ajv2020 from 'ajv/dist/2020.js';
import { readAudit } from '../src/actions.ts';
import { revokeDevice } from '../src/registry.ts';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { acceptNoise } from '@stim-cli/core/noise-session';
import { setupClient } from './noise-client.ts';
import { workspaceName, workspaceStateDir } from '@stim-cli/core';
import { captureProcessToken, processStartMicros } from '@stim-cli/core/process-identity';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { readPid } from './pid-file.ts';
import {
  jpeg,
  statusPayload,
  statusWith,
  OWNED_SIM,
  OWNED_WEB,
  OWNED_MACOS,
  toolCalls,
  startWithTools,
  toolRuns,
  fakeHelper,
  helperRuns,
  leasedPhonePayload,
  subscribeToFakeChrome,
  OWNED_EMULATOR,
  startControl,
  lockCalls,
  controlLease,
} from './server-frames-harness.ts';

describe('frames.subscribe', () => {
  it('preserves only the trusted AVD name when an attached emulator status becomes unknown', () => {
    const target = { workspace, platform: 'android' as const };
    const payload = (name: string) =>
      statusPayload({
        android: { name, owned: true, physical: false, serial: null, state: 'unknown' },
      }) as StatusPayload;
    expect(ownedDevice(payload('stim-app'), target, 'android:emulator-5554')).toEqual({
      platform: 'android',
      serial: 'emulator-5554',
      avdName: 'stim-app',
    });
    expect(ownedDevice(payload('../other-avd'), target, 'android:emulator-5554')).toEqual({
      platform: 'android',
      serial: 'emulator-5554',
    });
    expect(ownedDevice(payload('stim-app'), target, null)).toBeTypeOf('string');
  });

  test.skipIf(!fakeTailscale)(
    'sends a simulator screenshot when the screen changes and stops capturing with the last subscriber',
    async () => {
      const a = jpeg(390, 844, 'A');
      const b = jpeg(390, 844, 'B');
      const port = await startWithTools({
        FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
        FAKE_FRAMES: JSON.stringify([a, a, b].map((bytes) => bytes.toString('base64'))),
      });
      const first = await authed(port);
      expect(await first.request('frames.subscribe', { workspace, platform: 'ios', slot: 'default' })).toEqual({
        id: 2,
        result: { subscription: 's1' },
      });
      expect(await first.next()).toEqual({
        event: 'frame',
        subscription: 's1',
        platform: 'ios',
        slot: 'default',
        mime: 'image/jpeg',
        width: 390,
        height: 844,
        capturedAt: expect.any(String),
        data: a.toString('base64'),
      });
      const second = await authed(port);
      await second.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await second.next()).toMatchObject({ event: 'frame', data: a.toString('base64') });
      expect(readViewedDevices()).toEqual([{ platform: 'ios', id: 'SIM-1' }]);
      expect(await first.next()).toMatchObject({ event: 'frame', data: b.toString('base64') });
      expect(await second.next()).toMatchObject({ event: 'frame', data: b.toString('base64') });
      expect(toolRuns()[0]).toEqual({
        tool: 'xcrun',
        args: [
          'simctl',
          'io',
          'SIM-1',
          'screenshot',
          '--type=jpeg',
          '--display=primary',
          expect.stringMatching(/frame\.jpg$/),
        ],
      });

      first.socket.close();
      second.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(readViewedDevices()).toEqual([]);
      const settled = toolRuns().length;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(toolRuns()).toHaveLength(settled);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'sends the agent presence a local stim agent-device publishes to subscribers that asked for it',
    async () => {
      const port = await startWithTools({
        FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
        FAKE_FRAMES: JSON.stringify([jpeg(390, 844, 'A').toString('base64')]),
      });
      const viewer = await authed(port);
      await viewer.request('frames.subscribe', { workspace, platform: 'ios', presence: true });
      const presence = async () => {
        for (;;) {
          const message = await viewer.next();
          if ('event' in message && message.event === 'presence') return message;
        }
      };
      expect(await presence()).toEqual({ event: 'presence', subscription: 's1', participants: [] });
      const gesture = {
        kind: 'tap',
        from: { x: 0.5, y: 0.3 },
        durationMs: 0,
        target: { x: 0.25, y: 0.25, width: 0.5, height: 0.1 },
      };
      const publish = { workspace, platform: 'ios', command: 'press', phase: 'end', gesture };
      const remote = await authed(port, true);
      expect(await remote.request('presence.publish', publish)).toMatchObject({ error: { code: 'forbidden' } });
      const local = await desktop();
      expect(await local.request('presence.publish', { ...publish, gesture: { kind: 'drag' } })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await local.request('presence.publish', publish)).toMatchObject({ result: {} });
      expect(await presence()).toEqual({
        event: 'presence',
        subscription: 's1',
        participants: [{ id: 'a1', kind: 'agent', name: 'Agent \u00b7 press', color: 1, gesture }],
      });
    },
  );

  test.skipIf(!fakeTailscale)('refuses devices Stim does not own or that are not running', async () => {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({
        ios: { ...OWNED_SIM, state: 'Shutdown' },
        android: { name: 'Pixel', owned: false, physical: false, serial: 'emulator-5556', state: 'detected' },
        slots: [{ slot: 'tablet', ios: { ...OWNED_SIM, owned: false }, android: null }],
      }),
      FAKE_FRAMES: '[]',
    });
    const client = await authed(port);
    const refusals = [
      [{ platform: 'ios' }, 'is Shutdown, not booted'],
      [{ platform: 'ios', slot: 'tablet' }, 'No simulator Stim owns'],
      [{ platform: 'android' }, 'No emulator Stim owns'],
    ] as const;
    for (const [target, message] of refusals) {
      const reply = await client.request('frames.subscribe', { workspace, ...target });
      if (!('result' in reply)) throw new Error(JSON.stringify(reply));
      const { subscription } = reply.result as { subscription: string };
      expect(await client.next()).toEqual({
        event: 'error',
        subscription,
        error: { code: 'frames-failed', message: expect.stringContaining(message) },
      });
    }
    for (const [target, message] of [
      [{ platform: 'web' }, 'No Stim-owned Chrome runs'],
      [{ platform: 'web', slot: 'tablet' }, 'in the default slot'],
    ] as const) {
      const reply = await client.request('frames.subscribe', { workspace, ...target });
      if (!('result' in reply)) throw new Error(JSON.stringify(reply));
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { message: expect.stringContaining(message) },
      });
    }
    expect(await client.request('frames.subscribe', { workspace, platform: 'tv' })).toMatchObject({
      error: { code: 'bad-request' },
    });
    expect(await client.request('frames.subscribe', { workspace: join(root, 'other'), platform: 'ios' })).toMatchObject(
      { error: { code: 'unknown-workspace' } },
    );
    expect(toolRuns()).toEqual([]);
  });

  test.skipIf(!fakeTailscale)('ends the subscription when the simulator stops, and stops capturing', async () => {
    const statusFile = join(root, 'status.json');
    writeFileSync(statusFile, JSON.stringify(statusPayload({ ios: OWNED_SIM })));
    const port = await startWithTools({
      FAKE_STIM_STATUS_FILE: statusFile,
      FAKE_FRAMES: JSON.stringify([jpeg(10, 20, 'A').toString('base64')]),
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toMatchObject({ event: 'frame', width: 10, height: 20 });
    writeFileSync(`${statusFile}.next`, JSON.stringify(statusPayload({ ios: { ...OWNED_SIM, state: 'Shutdown' } })));
    renameSync(`${statusFile}.next`, statusFile);
    expect(await client.next()).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'frames-failed', message: expect.stringContaining('is Shutdown, not booted') },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = toolRuns().length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(toolRuns()).toHaveLength(settled);
  });

  test.skipIf(!fakeTailscale)('follows the lit iPhone Duo panel and reports its posture', async () => {
    const cover = jpeg(1398, 2034, 'cover');
    const inner = jpeg(2853, 2007, 'inner');
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-app (iPhone Duo 27.1)' } }),
      FAKE_FRAMES: JSON.stringify(
        [cover, jpeg(2034, 1398, 'BLACK'), inner, jpeg(2853, 2007, 'inner 2')].map((bytes) => bytes.toString('base64')),
      ),
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toMatchObject({ event: 'frame', width: 1398, height: 2034, posture: 'folded' });
    expect(await client.next()).toMatchObject({
      event: 'frame',
      width: 2853,
      height: 2007,
      data: inner.toString('base64'),
      posture: 'unfolded',
    });
    expect(await client.next()).toMatchObject({ event: 'frame', posture: 'unfolded' });
    const displays = toolRuns()
      .filter((run) => run.tool === 'xcrun')
      .map((run) => run.args.find((arg) => arg.startsWith('--display=')));
    expect(displays.slice(0, 4)).toEqual([
      '--display=primary',
      '--display=primary',
      '--display=primary-1',
      '--display=primary-1',
    ]);
    client.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = toolRuns().length;
    const again = await authed(port);
    await again.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await again.next()).toMatchObject({ event: 'frame', posture: 'unfolded' });
    expect(toolRuns()[before]?.args).toContain('--display=primary-1');
  });

  test.skipIf(!fakeTailscale)('captures the default display when simctl rejects primary', async () => {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
      FAKE_FRAMES: JSON.stringify([jpeg(10, 20, 'A').toString('base64')]),
      FAKE_XCRUN_NO_PRIMARY: '1',
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toMatchObject({ event: 'frame', width: 10, height: 20 });
    expect(toolRuns()[1]?.args).not.toContain('--display=primary');
  });

  test.skipIf(!fakeTailscale)('ends the subscription when a capture fails', async () => {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
      FAKE_FRAMES: '[]',
      FAKE_XCRUN_FAIL: '1',
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'frames-failed', message: expect.stringContaining('simctl failed on purpose') },
    });
  });

  test.skipIf(!fakeTailscale)(
    'treats a slow or timed-out capture as delayed, keeps the last frame, and recovers',
    async () => {
      const a = jpeg(10, 20, 'A');
      const b = jpeg(10, 20, 'B');
      const gate = join(root, 'capture-gate');
      const realSetTimeout = setTimeout;
      const ready = async (capture: number) => {
        const file = `${gate}.${capture}.ready`;
        for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((resolve) => realSetTimeout(resolve, 10));
        expect(existsSync(file)).toBe(true);
      };
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
          FAKE_FRAMES: JSON.stringify([a, b].map((bytes) => bytes.toString('base64'))),
          FAKE_XCRUN_DELAYS: JSON.stringify([200, 600, 20]),
          FAKE_XCRUN_DELAY_COUNTER: join(root, 'xcrun-delay-counter'),
          FAKE_XCRUN_GATE: gate,
        },
        { toolTimeoutMs: 400, slowCaptureMs: 150, failureBackoffMs: 100, maxConsecutiveFailures: 3 },
      );
      const client = await authed(port);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        await client.request('frames.subscribe', { workspace, platform: 'ios' });
        await ready(0);
        await vi.advanceTimersByTimeAsync(200);
        writeFileSync(`${gate}.0.release`, '');
        expect(await client.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: true });
        expect(await client.next()).toMatchObject({ event: 'frame', data: a.toString('base64') });
        await vi.advanceTimersByTimeAsync(200);
        await ready(1);
        await vi.advanceTimersByTimeAsync(400);
        const retained = await authed(port);
        await retained.request('frames.subscribe', { workspace, platform: 'ios' });
        expect(await retained.next()).toMatchObject({ event: 'frame', data: a.toString('base64') });
        expect(await retained.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: true });
        await vi.advanceTimersByTimeAsync(100);
        await ready(2);
        await vi.advanceTimersByTimeAsync(20);
        writeFileSync(`${gate}.2.release`, '');
        let recovered = false;
        let changed = false;
        while (!recovered || !changed) {
          const message = await client.next();
          if ('event' in message && message.event === 'frame-delayed') {
            expect(message).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: false });
            recovered = true;
          } else {
            expect(message).toMatchObject({ event: 'frame', data: b.toString('base64') });
            changed = true;
          }
        }
        expect(toolRuns().filter((run) => run.tool === 'xcrun').length).toBeGreaterThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'ends the subscription after captures keep timing out for a sustained period',
    async () => {
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
          FAKE_FRAMES: '[]',
          FAKE_XCRUN_DELAYS: JSON.stringify([300, 300]),
          FAKE_XCRUN_DELAY_COUNTER: join(root, 'xcrun-delay-counter'),
        },
        { toolTimeoutMs: 100, slowCaptureMs: 50, failureBackoffMs: 20, maxConsecutiveFailures: 2 },
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await client.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: true });
      expect(await client.next()).toEqual({
        event: 'error',
        subscription: 's1',
        error: { code: 'frames-failed', message: expect.stringContaining('did not finish within') },
      });
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'routes composed Duo images and their pose together without replacing raw subscribers',
    async () => {
      const pose = { revision: '16ef79a2-5cef-4cdb-b5e9-ab09ef0722d2', screenID: 10, angle: 76, orientation: 3 };
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-test (iPhone Duo 27.1)' } }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_DUO: JSON.stringify({ width: 800, height: 600, ...pose }),
        },
        undefined,
        fakeHelper(),
        { foldHelper: join(root, 'sim-fold') },
      );
      const plain = await authed(port);
      await plain.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await plain.next()).toMatchObject({ event: 'frame', width: 390, height: 844 });
      const composed = await authed(port);
      expect(
        await composed.request('frames.subscribe', { workspace, platform: 'ios', duoFrame: true, video: ['h264'] }),
      ).toMatchObject({ result: { subscription: 's1' } });
      let shown = await composed.next();
      while ('event' in shown && shown.event === 'frame' && !shown.duo) shown = await composed.next();
      expect(shown).toMatchObject({ event: 'frame', width: 800, height: 600, duo: pose });
      expect(Buffer.from((shown as { data: string }).data, 'base64').toString()).toMatch(/^composed /);
      const raw = await plain.next();
      expect(raw).toMatchObject({ event: 'frame', width: 390, height: 844 });
      expect(raw).not.toHaveProperty('duo');
      expect(Buffer.from((raw as { data: string }).data, 'base64').toString()).toMatch(/^frame /);
      const cached = await authed(port);
      await cached.request('frames.subscribe', { workspace, platform: 'ios', duoFrame: true });
      expect(await cached.next()).toMatchObject({ event: 'frame', duo: pose });
      expect(
        await cached.request('frames.subscribe', { workspace, platform: 'android', duoFrame: true }),
      ).toMatchObject({ error: { code: 'bad-request' } });
      for (const client of [plain, composed, cached]) client.socket.close();
    },
  );

  test.skipIf(!fakeTailscale)(
    'sends cached installed artwork only to opt-in read subscribers and preserves guest bytes',
    async () => {
      const artwork = {
        width: 450,
        height: 900,
        aperture: { x: 30, y: 20, width: 390, height: 844 },
        cornerRadius: 12,
        quarterTurns: 2,
        background: 'png-bg',
        foreground: 'png-fg',
      };
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_ARTWORK: JSON.stringify(artwork),
        },
        undefined,
        fakeHelper(),
      );
      const framed = await authed(port);
      await framed.request('frames.subscribe', { workspace, platform: 'ios', deviceFrame: true });
      expect(await framed.next()).toMatchObject({ event: 'device-frame', artwork: null });
      expect(await framed.next()).toMatchObject({ event: 'device-frame', artwork });
      const captured = await framed.next();
      expect(captured).toMatchObject({ event: 'frame', width: 390, height: 844, artworkTurns: 2 });
      expect(Buffer.from((captured as { data: string }).data, 'base64').toString()).toMatch(/^frame /);
      const plain = await authed(port);
      await plain.request('frames.subscribe', { workspace, platform: 'ios' });
      expect(await plain.next()).toMatchObject({ event: 'frame' });
      const again = await authed(port);
      await again.request('frames.subscribe', { workspace, platform: 'ios', deviceFrame: true });
      expect(await again.next()).toMatchObject({ event: 'device-frame', artwork: null });
      expect(await again.next()).toMatchObject({ event: 'device-frame', artwork });
      expect(
        await again.request('frames.subscribe', { workspace: '/not-registered', platform: 'ios', deviceFrame: true }),
      ).toMatchObject({ error: { code: 'unknown-workspace' } });
      const video = await authed(port);
      await video.request('frames.subscribe', { workspace, platform: 'ios', deviceFrame: true, video: ['h264'] });
      expect(await video.next()).toMatchObject({ event: 'device-frame', artwork: null });
      expect(await video.next()).toMatchObject({ event: 'device-frame', artwork });
      const packet = ((await video.next()) as unknown as { binary: Buffer }).binary;
      expect(packet[1]! & 56).toBe(32 | (2 << 3));
      expect(packet.subarray(packet.readUInt16BE(2), packet.readUInt16BE(2) + 4)).toEqual(Buffer.from([0, 0, 0, 1]));
      video.socket.close();
      framed.socket.close();
      plain.socket.close();
      again.socket.close();
    },
  );

  test.skipIf(process.platform !== 'darwin')(
    'routes hosted macOS frames and native input without local viewer permission setup',
    async () => {
      const captureHelper = fakeHelper();
      writeFileSync(
        captureHelper,
        readFileSync(captureHelper, 'utf8').replace('run.configs.push(line);', 'run.configs.push(line); record();'),
      );
      const port = await startWithTools({ FAKE_STIM_PAYLOADS: '[]' }, undefined, captureHelper);
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
        import {writeFileSync} from 'node:fs';import {join} from 'node:path';
        const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
        const input=JSON.parse(Buffer.concat(chunks));
        const device={architecture:'arm64',macosVersion:'27.0',appSlot:input.appSlot};
        if(input.mode==='prepare')writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
        process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
      `,
      );
      const pending = setupClient(['device-host'], 'Hosting Mac client');
      const client = await returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      const reserved = await client.request('device-host.reserve', {
        workspace: '/client/not-worker-registered',
        slot: 'default',
        platform: 'macos',
        attempt: 'hosted-macos-view',
      });
      if (!('result' in reserved)) throw new Error(JSON.stringify(reserved));
      const session = (reserved.result as { id: string }).id;
      await vi.waitFor(async () =>
        expect(await client.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready'),
      );
      const appProcess = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      try {
        const appAttempt = 'app-first';
        const area = join(deviceHostArea(session), 'apps', appAttempt);
        const workerHome = join(deviceHostArea(session), 'home');
        const bundle = join(area, 'App.app');
        mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
        const executable = join(bundle, 'Contents', 'MacOS', 'Fixture');
        writeFileSync(executable, 'fixture');
        mkdirSync(join(workerHome, 'macos-app'));
        const state = join(workerHome, 'workspaces', workspaceName(realpathSync(join(workerHome, 'macos-app'))));
        mkdirSync(state, { recursive: true });
        const appStart = processStartMicros(appProcess.pid!);
        const processToken = captureProcessToken(appProcess.pid!);
        if (appStart.status !== 'running' || !processToken) throw new Error('Cannot identify fake macOS app');
        const identity = { pid: appProcess.pid!, processToken, startedAtMicros: appStart.startedAtMicros };
        const bundleId = 'dev.stim.fixture.hosted1';
        writeFileSync(
          join(state, 'state.json'),
          JSON.stringify({
            macos: {
              launchId: 'launch-1',
              arguments: [],
              product: 'Fixture',
              bundle,
              bundleId,
              executable,
              build: { state: 'ok', startedAt: new Date().toISOString() },
              app: identity,
              supervisor: identity,
            },
          }),
        );
        writeFileSync(join(workerHome, 'hosted-macos-app.json'), JSON.stringify({ bundleId }));
        writeFileSync(
          join(area, 'receipt.json'),
          JSON.stringify({
            session,
            attempt: appAttempt,
            bundleId: 'dev.stim.fixture',
            mode: 'release',
            manifest: { size: 1, sha256: 'a'.repeat(64) },
            state: 'installed',
            launched: true,
          }),
        );
        const journal = join(deviceHostRoot(), 'sessions.json');
        const stored = JSON.parse(readFileSync(journal, 'utf8'));
        stored.sessions[0].appAttempt = appAttempt;
        writeFileSync(journal, JSON.stringify(stored));
        expect(await client.request('device-host.frames.subscribe', { session, at: 1 })).toHaveProperty(
          'error.code',
          'bad-request',
        );
        expect(await client.request('device-host.frames.subscribe', { session })).toHaveProperty(
          'result.subscription',
          's1',
        );
        expect(await client.next()).toMatchObject({ event: 'frame', subscription: 's1', platform: 'macos' });
        expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toHaveProperty(
          'nativeViewerOpened',
          false,
        );
        const begun = await client.request('device-host.control.begin', { session });
        if (!('result' in begun)) throw new Error(JSON.stringify(begun));
        const controlSession = (begun.result as { session: string }).session;
        expect(
          await client.request('device-host.input.scroll', {
            session: controlSession,
            x: 0.25,
            y: 0.75,
            deltaX: -5,
            deltaY: 10,
          }),
        ).toHaveProperty('result');
        expect(
          await client.request('device-host.input.key', { session: controlSession, key: 'a', modifiers: ['command'] }),
        ).toHaveProperty('result');
        expect(await client.request('device-host.input.window', { session: controlSession, window: 7 })).toHaveProperty(
          'result',
        );
        expect(
          await client.request('device-host.input.window', { session: controlSession, window: null }),
        ).toHaveProperty('result');
        expect(
          await client.request('device-host.input.key', { session: controlSession, key: 'invalid' }),
        ).toHaveProperty('error.code', 'bad-request');
        expect(
          await client.request('device-host.input.scroll', {
            session: controlSession,
            x: 2,
            y: 0,
            deltaX: 0,
            deltaY: 0,
          }),
        ).toHaveProperty('error.code', 'bad-request');
        await vi.waitFor(() => {
          const configs = helperRuns().flatMap((run) => run.configs);
          expect(configs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ input: 'scroll', deltaX: -5, deltaY: 10 }),
              expect.objectContaining({ input: 'key', key: 'a', modifiers: ['command'] }),
              expect.objectContaining({ input: 'window', window: 7, controlSession: expect.any(String) }),
              expect.objectContaining({ input: 'window', window: null, controlSession: expect.any(String) }),
            ]),
          );
          const args = helperRuns()[0]!.args;
          expect(args[0]).toBe('macos');
          expect(JSON.parse(args[1]!)).toMatchObject({ bundleId, app: { pid: appProcess.pid } });
        });
        expect(await client.request('device-host.stop', { session })).toHaveProperty('result.state', 'stopping');
        await vi.waitFor(async () =>
          expect(await client.request('device-host.attach', { session })).toHaveProperty('result.state', 'stopped'),
        );
      } finally {
        appProcess.kill('SIGKILL');
        await new Promise<void>((resolve) => appProcess.once('exit', () => resolve()));
      }
    },
  );

  test.skipIf(!fakeTailscale)(
    'streams and controls only the hosting client session and closes its capture before native stop',
    async () => {
      const captureHelper = fakeHelper();
      writeFileSync(
        captureHelper,
        readFileSync(captureHelper, 'utf8')
          .replace("process.on('SIGTERM', () => process.exit(0));", "process.on('SIGTERM', () => {});")
          .replace("process.stdin.on('end', () => process.exit(0));", "process.stdin.on('end', () => {});")
          .replace('run.configs.push(line);', 'run.configs.push(line); record();'),
      );
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }) },
        undefined,
        captureHelper,
      );
      writeFileSync(
        join(root, 'device-host-worker.mjs'),
        `
        import { writeFileSync, readFileSync, existsSync } from 'node:fs';
        import { delimiter, dirname, join } from 'node:path';
        const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
        const input=JSON.parse(Buffer.concat(chunks));
        const device={udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
        const home=process.env.STIM_HOME;
        if(input.mode==='prepare') {
          writeFileSync(join(home,'hosted-device.json'),JSON.stringify(device));
          writeFileSync(join(home,'created-devices.json'),JSON.stringify({version:1,ios:[device.udid],android:[],web:[]}));
        } else {
          const file=process.env.FAKE_TOOL_CALLS+'.started';
          const pids=existsSync(file)?readFileSync(file,'utf8').trim().split(/\\s+/).filter(Boolean).map(Number):[];
          if(pids.some(pid=>{try{process.kill(pid,0);return true;}catch{return false;}})) {
            process.stdout.write(JSON.stringify({state:'unknown',device,notice:'capture still running'}));
            process.exit(0);
          }
        }
        process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':'stopped',device}));
      `,
      );
      const pending = setupClient(['device-host'], 'Hosting client');
      const open = () => returning(port, pending.keyPair, '100.64.0.2', 'device-host');
      const first = await open();
      const observerIdentity = await pair(port);
      const observer = await returning(port, observerIdentity.keyPair);
      const reserved = await first.request('device-host.reserve', {
        workspace: '/client/not-worker-registered',
        slot: 'phone',
        platform: 'ios',
        attempt: 'hosted-view',
      });
      if (!('result' in reserved)) throw new Error(JSON.stringify(reserved));
      const session = (reserved.result as { id: string }).id;
      await vi.waitFor(async () =>
        expect(await first.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready'),
      );
      expect(await first.request('frames.subscribe', { workspace, platform: 'ios' })).toHaveProperty(
        'error.code',
        'forbidden',
      );
      expect(await first.request('device-host.frames.subscribe', { session, at: 1 })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      expect(await first.request('device-host.frames.subscribe', { session, fps: 5 })).toHaveProperty(
        'result.subscription',
        's1',
      );
      expect(await first.next()).toMatchObject({ event: 'frame', subscription: 's1', platform: 'ios', slot: 'phone' });
      expect(await first.request('device-host.frames.subscribe', { session, video: ['h264'] })).toMatchObject({
        result: { subscription: 's2', video: 'h264' },
      });
      let streamed = await first.next();
      while (!('binary' in streamed)) streamed = await first.next();
      expect(await first.request('device-host.frames.keyframe', { subscription: 's2' })).toHaveProperty('result');
      expect(await first.request('device-host.frames.congested', { subscription: 's1' })).toHaveProperty(
        'error.code',
        'unknown-subscription',
      );
      expect(await first.request('device-host.frames.congested', { subscription: 's2' })).toHaveProperty('result');
      await vi.waitFor(() =>
        expect(helperRuns().flatMap((run) => run.configs)).toContainEqual(
          expect.objectContaining({ video: true, bitrate: 1_500_000 }),
        ),
      );
      expect(await first.request('device-host.unsubscribe', { subscription: 's2' })).toHaveProperty('result');
      const claimRoot = join(deviceHostRoot(), `${session}.claims`);
      const helper = readClaimSet(claimRoot).live[0]!.child;
      expect(helper).not.toBeNull();
      expect(alive(helper!.pid)).toBe(true);
      const began = await first.request('device-host.control.begin', { session });
      if (!('result' in began)) throw new Error(JSON.stringify(began));
      const controlSession = (began.result as { session: string }).session;
      expect(began).toHaveProperty('result.lease', null);
      expect(
        await first.request('device-host.input.touch', { session: controlSession, phase: 'down', x: 0, y: 1 }),
      ).toHaveProperty('result');
      expect(
        await first.request('device-host.input.touch', { session: controlSession, phase: 'up', x: 0, y: 1 }),
      ).toHaveProperty('result');
      const sameClient = await open();
      const joined = await sameClient.request('device-host.control.begin', { session });
      assert(
        'result' in joined && joined.result && 'session' in joined.result && typeof joined.result.session === 'string',
      );
      const joinedSession = joined.result.session;
      expect(joinedSession).not.toBe(controlSession);
      expect(await sameClient.request('device-host.control.end', { session: joinedSession })).toHaveProperty('result');
      expect(
        await sameClient.request('device-host.input.touch', { session: controlSession, phase: 'down', x: 1, y: 0 }),
      ).toHaveProperty('error.code', 'unknown-session');
      const other = setupClient(['device-host'], 'Other client');
      const foreign = await returning(port, other.keyPair, '100.64.0.3', 'device-host');
      expect(await foreign.request('device-host.frames.subscribe', { session })).toHaveProperty(
        'error.code',
        'action-failed',
      );
      revokeDevice(observerIdentity.id);
      await observer.closed;
      expect(
        await first.request('device-host.input.touch', { session: controlSession, phase: 'move', x: 0.5, y: 0.5 }),
      ).toHaveProperty('result');
      first.socket.close();
      await first.closed;
      await until(() => !alive(helper!.pid));
      expect(await sameClient.request('device-host.attach', { session })).toHaveProperty('result.state', 'ready');
      expect(await sameClient.request('device-host.frames.subscribe', { session })).toHaveProperty(
        'result.subscription',
        's1',
      );
      expect(await sameClient.next()).toMatchObject({ event: 'frame', subscription: 's1', slot: 'phone' });
      const replacement = readClaimSet(claimRoot).live[0]!.child;
      expect(replacement!.pid).not.toBe(helper!.pid);
      expect(await sameClient.request('device-host.stop', { session })).toHaveProperty('result.state', 'stopping');
      await vi.waitFor(
        async () =>
          expect(await sameClient.request('device-host.attach', { session })).toHaveProperty('result.state', 'stopped'),
        { timeout: 4000 },
      );
      expect(alive(replacement!.pid)).toBe(false);
      expect(readClaimSet(claimRoot).live).toEqual([]);
      const captures = [...new Map(helperRuns().map((run) => [run.pid, run])).values()];
      expect(captures.map((run) => run.args)).toEqual([
        ['ios', '12345678-1234-1234-1234-123456789abc'],
        ['ios', '12345678-1234-1234-1234-123456789abc'],
      ]);
      expect(captures[0]!.configs).toEqual(
        expect.arrayContaining([
          { input: 'touch', phase: 'down', x: 0, y: 1, display: 0 },
          { input: 'touch', phase: 'up', x: 0, y: 1, display: 0 },
        ]),
      );
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'streams helper frames at the rate each subscriber asks for and stops the helper with the last one',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '10' },
        undefined,
        fakeHelper(),
      );
      const slow = await authed(port);
      const fast = await authed(port);
      await slow.request('frames.subscribe', { workspace, platform: 'ios', fps: 2, maxEdge: 480 });
      await fast.request('frames.subscribe', { workspace, platform: 'ios', fps: 20, maxEdge: 960 });
      expect(await fast.next()).toMatchObject({ event: 'frame', platform: 'ios', mime: 'image/jpeg', width: 390 });
      const counted = { slow: 0, fast: 0 };
      slow.socket.on('message', () => counted.slow++);
      fast.socket.on('message', () => counted.fast++);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(counted.slow).toBeLessThanOrEqual(3);
      expect(counted.fast).toBeGreaterThanOrEqual(10);
      expect(counted.fast).toBeLessThanOrEqual(22);
      expect(helperRuns()).toEqual([]);
      fast.socket.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      slow.socket.close();
      await until(() => helperRuns().length === 1);
      const [run] = helperRuns();
      expect(run!.args).toEqual(['ios', 'SIM-1']);
      const jpegOnly = { jpeg: true, video: false, bitrate: 3_000_000 };
      expect(run!.configs).toEqual([
        { fps: 2, maxEdge: 480, jpegFps: 2, ...jpegOnly },
        { fps: 20, maxEdge: 960, jpegFps: 20, ...jpegOnly },
        { fps: 2, maxEdge: 480, jpegFps: 2, ...jpegOnly },
        { fps: 0, maxEdge: 480, jpeg: false, video: false, bitrate: 3_000_000 },
      ]);
      await until(() => !alive(run!.pid));
      expect(toolRuns().filter((entry) => entry.tool === 'xcrun')).toEqual([]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'streams the owned Chrome page through the helper with its verified DevTools target',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ web: OWNED_WEB }), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '10' },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      expect(
        await client.request('frames.subscribe', { workspace, platform: 'web', fps: 60, video: ['h264'] }),
      ).toMatchObject({
        result: { video: 'h264' },
      });
      await new Promise((resolve) => client.socket.once('message', resolve));
      client.socket.close();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args).toEqual(['web', 'http://127.0.0.1:8900', '4242', 'PAGE-1']);
    },
    10_000,
  );

  test.each([undefined, false, true])(
    'streams a verified native app to a read-only phone without control, replay or device tools (pinned: %s)',
    { skip: !fakeTailscale, timeout: 10_000 },
    async (pinned) => {
      const windows = [
        { id: 12, title: 'MyApp', frame: { x: -100, y: 20, width: 800, height: 600 } },
        { id: 13, title: '', frame: { x: 100, y: -20, width: 400, height: 300 } },
      ];
      const macosWindows = { current: windows[0], windows, pinned: pinned ?? false };
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ macos: OWNED_MACOS }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_INTERVAL_MS: '10',
          FAKE_HELPER_MACOS_WINDOWS: JSON.stringify({ ...macosWindows, pinned }),
          FAKE_HELPER_MACOS_WINDOWS_MALFORMED: JSON.stringify(
            pinned === undefined
              ? { current: null, windows: [{ id: -1 }] }
              : { current: null, windows: [], pinned: 'yes' },
          ),
        },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      expect(await client.request('frames.subscribe', { workspace, platform: 'macos', video: ['h264'] })).toMatchObject(
        { result: { video: 'h264' } },
      );
      const event = await client.next();
      expect(event).toEqual({ event: 'macos-windows', subscription: 's1', ...macosWindows });
      const validator = new Ajv2020({ strict: false, validateFormats: false });
      validator.addSchema(protocolJsonSchema(), 'protocol');
      const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
      expect(acceptsEvent(event)).toBe(true);
      expect(
        acceptsEvent({ event: 'macos-windows', subscription: 's1', current: null, windows: [], pinned: false }),
      ).toBe(true);
      expect(acceptsEvent({ event: 'macos-windows', subscription: 's1', current: null, windows: [] })).toBe(false);
      expect(acceptsEvent({ ...event, pinned: 'yes' })).toBe(false);
      expect(await client.next()).toHaveProperty('binary');
      const again = await authed(port);
      expect(await again.request('frames.subscribe', { workspace, platform: 'macos', video: ['h264'] })).toMatchObject({
        result: { subscription: 's1', video: 'h264' },
      });
      expect(await again.next()).toEqual({ event: 'macos-windows', subscription: 's1', ...macosWindows });
      expect(await again.next()).toHaveProperty('binary');
      expect(await client.request('control.begin', { workspace, platform: 'macos' })).toMatchObject({
        error: { code: 'forbidden' },
      });
      expect(await client.request('replay.range', { workspace, platform: 'macos' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      client.socket.close();
      again.socket.close();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args).toEqual(['macos', JSON.stringify(OWNED_MACOS)]);
      expect(toolRuns().filter((run) => run.tool === 'xcrun' || run.tool === 'adb')).toEqual([]);
      expect(readViewedDevices()).toEqual([]);
    },
  );

  test.skipIf(!fakeTailscale)(
    'controls only an owned native app session and keeps its view alive after an input permission refusal',
    async () => {
      const helper = fakeHelper();
      writeFileSync(
        helper,
        readFileSync(helper, 'utf8')
          .replace('else config = line;', 'else if (!line.input && !line.control) config = line;')
          .replace(
            'run.configs.push(line);',
            `run.configs.push(line); record();
          if (line.input === 'key' && line.key === 'escape') message(2, Buffer.from(JSON.stringify({ inputError: 'Control needs existing Accessibility permission.', controlSession: line.controlSession })));
          const enabled = run.configs.filter(c => c.control?.enabled);
          if (line.input === 'key' && line.key === 'a' && enabled.length > 1) message(2, Buffer.from(JSON.stringify({ inputError: 'Delayed failure from old controller.', controlSession: enabled[0].control.session })));`,
          ),
      );
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({
            macos: OWNED_MACOS,
            android: {
              ...OWNED_EMULATOR,
              activity: { state: 'driven', driver: { tool: 'agent-device', pid: 42, since: null }, basis: [] },
            },
          }),
          FAKE_HELPER_INTERVAL_MS: '10',
        },
        undefined,
        helper,
      );
      const client = await authed(port, true);
      const observerIdentity = await pair(port);
      const observer = await returning(port, observerIdentity.keyPair);
      const viewed = await observer.request('frames.subscribe', { workspace, platform: 'macos' });
      const begun = await client.request('control.begin', { workspace, platform: 'macos' });
      expect(begun).toMatchObject({ result: { platform: 'macos', lease: null, postures: [] } });
      const { session } = (begun as { result: { session: string } }).result;
      const other = await authed(port, true);
      const joined = await other.request('control.begin', { workspace, platform: 'macos' });
      assert(
        'result' in joined && joined.result && 'session' in joined.result && typeof joined.result.session === 'string',
      );
      expect(joined).toHaveProperty('result.platform', 'macos');
      const joinedSession = joined.result.session;
      expect(await other.request('control.end', { session: joinedSession })).toHaveProperty('result');
      expect(await other.request('input.text', { session, text: 'wrong connection' })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.5, y: 0.5 })).toHaveProperty('result');
      expect(await client.request('input.text', { session, text: 'native' })).toHaveProperty('result');
      expect(await client.request('input.scroll', { session, x: 0.5, y: 0.5, deltaX: 0, deltaY: -30 })).toHaveProperty(
        'result',
      );
      expect(await client.request('input.scroll', { session, x: 0.5, y: 0.5, deltaX: 0, deltaY: 1001 })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      expect(
        await client.request('input.key', { session, key: 'a', modifiers: ['command', 'command'] }),
      ).toHaveProperty('error.code', 'bad-request');
      expect(await client.request('input.key', { session, key: 'space', modifiers: ['command'] })).toHaveProperty(
        'error.code',
        'bad-request',
      );
      expect(await client.request('input.key', { session, key: 'q', modifiers: ['command'] })).toHaveProperty('result');
      expect(await client.request('input.key', { session, key: '7', modifiers: ['shift'] })).toHaveProperty('result');
      expect(await client.request('input.key', { session, key: 'a', modifiers: ['command'] })).toHaveProperty('result');
      expect(await client.request('input.window', { session, window: 12 })).toHaveProperty('result');
      expect(await client.request('input.window', { session, window: null })).toHaveProperty('result');
      for (const window of [undefined, -1, 0x100000000, 1.5, '12'])
        expect(await client.request('input.window', { session, window })).toHaveProperty('error.code', 'bad-request');
      for (const [method, params] of [
        ['input.rotate', { direction: 'left' }],
        ['input.button', { button: 'home' }],
        ['input.simulator', { action: 'shake' }],
      ]) {
        expect(await client.request(method as string, { session, ...(params as object) })).toHaveProperty(
          'error.code',
          'bad-request',
        );
      }
      const ended = client.next();
      expect(await client.request('input.key', { session, key: 'escape' })).toHaveProperty('result');
      expect(await ended).toMatchObject({ reason: 'failed', message: expect.stringContaining('Accessibility') });
      expect(await client.request('input.text', { session, text: 'after refusal' })).toHaveProperty(
        'error.code',
        'unknown-session',
      );
      expect(
        await new Promise((resolve) => observer.socket.once('message', (raw) => resolve(JSON.parse(raw.toString())))),
      ).toMatchObject({ subscription: (viewed as { result: { subscription: string } }).result.subscription });
      expect(lockCalls()).toEqual([]);
      const sent = helperRuns().at(-1)!.configs;
      const active = sent.find((entry) => entry.control && (entry.control as { enabled: boolean }).enabled)!
        .control as { session: string };
      expect(sent.filter((entry) => entry.input).map((entry) => entry.controlSession)).toEqual(
        Array(10).fill(active.session),
      );
      expect(sent.filter((entry) => entry.input === 'window')).toEqual([
        { input: 'window', window: 12, controlSession: active.session },
        { input: 'window', window: null, controlSession: active.session },
      ]);
      const resumed = await client.request('control.begin', { workspace, platform: 'macos' });
      const next = (resumed as { result: { session: string } }).result.session;
      expect(await client.request('input.key', { session: next, key: 'a', modifiers: ['command'] })).toHaveProperty(
        'result',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        await client.request('input.text', { session: next, text: 'new controller survives old notice' }),
      ).toHaveProperty('result');
      other.socket.close();
      observer.socket.close();
      client.socket.close();
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'preserves a native capture permission failure without a screenshot fallback',
    async () => {
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ macos: OWNED_MACOS }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_FAIL: 'Screen Recording access is unavailable',
        },
        undefined,
        fakeHelper(),
      );
      const before = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(before).toHaveProperty('nativeViewerOpened', false);
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'macos' });
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { code: 'frames-failed', message: expect.stringContaining('Screen Recording access is unavailable') },
      });
      const after = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(after).toHaveProperty('nativeViewerOpened', true);
      expect(toolRuns().filter((run) => run.tool === 'xcrun' || run.tool === 'adb')).toEqual([]);
    },
    10_000,
  );

  test.each([{ state: 'stopped' }, { state: 'unverified' }, { app: undefined }])(
    'refuses native windows without a verified running process: %j',
    async (extra) => {
      if (!fakeTailscale) return;
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ macos: { ...OWNED_MACOS, ...extra } }), FAKE_FRAMES: '[]' },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'macos' });
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { code: 'frames-failed', message: expect.stringContaining('No verified owned macOS app') },
      });
      expect(helperRuns()).toEqual([]);
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toHaveProperty('nativeViewerOpened', false);
    },
  );

  test.skipIf(!fakeTailscale)(
    "streams the physical iPhone the workspace leases in the slot, with the helper's stall reason until it clears",
    async () => {
      const locked = 'The iPhone is locked. Unlock it to see its screen.';
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: leasedPhonePayload(),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_STALLED: locked,
          FAKE_HELPER_STALL_CLEAR_MS: '600',
          FAKE_HELPER_INTERVAL_MS: '100000',
        },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
      const stalled = { event: 'frame-delayed', subscription: 's1', delayed: true, reason: locked };
      expect(await client.next()).toEqual(stalled);
      const late = await authed(port);
      await late.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
      expect(await late.next()).toEqual(stalled);
      expect(await client.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: false });
      expect(await late.next()).toEqual({ event: 'frame-delayed', subscription: 's1', delayed: false });
      expect(readViewedDevices()).toEqual([]);
      client.socket.close();
      late.socket.close();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.args).toEqual(['iphone', 'PHONE-1', 'Old iPhone']);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'ends a physical iPhone subscription when the helper fails, without falling back to simctl',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: leasedPhonePayload(null), FAKE_FRAMES: '[]', FAKE_HELPER_FAIL: 'not cabled on purpose' },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      await client.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
      expect(await client.next()).toMatchObject({
        event: 'error',
        error: { code: 'frames-failed', message: expect.stringContaining('not cabled on purpose') },
      });
      expect(toolRuns().filter((entry) => entry.tool === 'xcrun')).toEqual([]);
      expect(helperRuns()[0]!.args).toEqual(['iphone', 'PHONE-1']);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    "never replays a slot's simulator footage for a physical iPhone",
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: leasedPhonePayload(), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '100000' },
        undefined,
        fakeHelper(),
      );
      const recordings = join(workspaceStateDir(workspace), 'recordings', 'ios-default');
      mkdirSync(recordings, { recursive: true });
      const at = Date.now() - 1000;
      const unit = Buffer.alloc(17);
      unit.writeUInt32BE(18, 0);
      unit.writeUInt8(1, 4);
      unit.writeDoubleBE(at, 5);
      unit.writeUInt16BE(330, 13);
      unit.writeUInt16BE(720, 15);
      writeFileSync(join(recordings, `${at}-${at}.seg`), Buffer.concat([unit, Buffer.from([0, 0, 0, 1, 0])]));
      const sim = await authed(port);
      expect(await sim.request('frames.subscribe', { workspace, platform: 'ios', video: ['h264'], at })).toMatchObject({
        result: { subscription: 's1' },
      });
      sim.socket.close();
      const client = await authed(port);
      const target = { workspace, platform: 'ios', physical: true, video: ['h264'] };
      expect(await client.request('frames.subscribe', { ...target, at })).toMatchObject({
        error: { code: 'no-recording' },
      });
      await client.request('frames.subscribe', target);
      expect(await client.request('frames.seek', { subscription: 's1', at, rate: 0 })).toMatchObject({
        error: { code: 'no-recording' },
      });
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('refuses a physical iPhone the workspace holds no lease on', async () => {
    const port = await startWithTools(
      { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]' },
      undefined,
      fakeHelper(),
    );
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios', physical: true });
    expect(await client.next()).toMatchObject({
      event: 'error',
      error: { code: 'frames-failed', message: expect.stringContaining('leases no physical iPhone') },
    });
    expect(helperRuns()).toEqual([]);
  });

  test.skipIf(!fakeTailscale)('captures the owned Chrome page with screenshots without the helper', async () => {
    expect(await subscribeToFakeChrome(4242)).toMatchObject({
      event: 'frame',
      platform: 'web',
      width: 1280,
      height: 800,
    });
  });

  test.skipIf(!fakeTailscale)('refuses a DevTools port that another Chrome serves', async () => {
    expect(await subscribeToFakeChrome(999)).toMatchObject({
      event: 'error',
      error: { code: 'frames-failed', message: expect.stringContaining('not the owned Chrome 4242') },
    });
  });

  test.skipIf(!fakeTailscale)(
    'keeps the helper for a client that comes back within the linger time, and stops it after',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '10' },
        { lingerMs: 600 },
        fakeHelper(),
      );
      const client = await authed(port);
      const oneFrame = async () => {
        const reply = await client.request('frames.subscribe', { workspace, platform: 'ios', maxEdge: 640 });
        const { subscription } = (reply as { result: { subscription: string } }).result;
        const frame = await client.next();
        expect(frame).toMatchObject({ event: 'frame', subscription });
        let done = await client.request('unsubscribe', { subscription });
        while (!('id' in done)) done = await client.next();
      };
      const started = () => readFileSync(`${toolCalls}.started`, 'utf8').split('\n').filter(Boolean);
      await oneFrame();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await oneFrame();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await oneFrame();
      expect(started()).toHaveLength(1);
      const pid = Number(started()[0]);
      expect(alive(pid)).toBe(true);
      await until(() => !alive(pid));
      const configs = helperRuns()[0]!.configs;
      expect(configs.map((config) => config.fps === 0)).toEqual([false, true, false, true, false, true]);
      expect(configs.at(-1)).toMatchObject({ jpeg: false, video: false });
      expect(configs.at(-1)).not.toHaveProperty('record');
      await oneFrame();
      expect(started()).toHaveLength(2);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'streams H.264 as binary messages to a client that decodes it, and a keyframe on request',
    async () => {
      const port = await startWithTools(
        { FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }), FAKE_FRAMES: '[]', FAKE_HELPER_INTERVAL_MS: '10' },
        undefined,
        fakeHelper(),
      );
      const client = await authed(port);
      expect(
        await client.request('frames.subscribe', { workspace, platform: 'ios', fps: 60, video: ['vp9', 'h264'] }),
      ).toMatchObject({ result: { subscription: 's1', video: 'h264' } });
      const packet = (await client.next()) as unknown as { binary: Buffer };
      expect(packet.binary.readUInt8(1)).toBe(1);
      expect(packet.binary.readUInt32BE(4)).toBe(0);
      expect(packet.binary.toString('ascii', 21, 23)).toBe('s1');
      expect([packet.binary.readUInt16BE(16), packet.binary.readUInt16BE(18)]).toEqual([588, 1280]);
      expect([...packet.binary.subarray(23, 28)]).toEqual([0, 0, 0, 1, 0x65]);
      expect(await client.request('frames.keyframe', { subscription: 's1' })).toMatchObject({ result: {} });
      let message = await client.next();
      while ('binary' in message && !((message as unknown as { binary: Buffer }).binary.readUInt8(1) & 1)) {
        message = await client.next();
      }
      expect(message).toHaveProperty('binary');
      expect(await client.request('frames.keyframe', { subscription: 's9' })).toMatchObject({
        error: { code: 'unknown-subscription' },
      });
      client.socket.close();
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs.slice(0, 2)).toEqual([
        { fps: 60, maxEdge: 1280, jpeg: false, video: true, bitrate: 3_000_000 },
        { keyframe: true },
      ]);
      expect(helperRuns()[0]!.configs.filter((line) => 'keyframe' in line)).toHaveLength(2);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'streams the lit iPhone Duo panel through the helper and reports its posture',
    async () => {
      const port = await startWithTools(
        {
          FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-app (iPhone Duo 27.1)' } }),
          FAKE_FRAMES: '[]',
          FAKE_HELPER_INTERVAL_MS: '10',
          FAKE_HELPER_DISPLAYS: JSON.stringify([0, ...Array(29).fill(null), 1]),
        },
        undefined,
        fakeHelper(),
      );
      const viewer = await authed(port);
      const tile = await authed(port);
      expect(
        await viewer.request('frames.subscribe', { workspace, platform: 'ios', fps: 60, video: ['h264'] }),
      ).toMatchObject({ result: { video: 'h264' } });
      await tile.request('frames.subscribe', { workspace, platform: 'ios', fps: 30 });
      const flags: number[] = [];
      while (!((flags.at(-1) ?? 0) & 4))
        flags.push(((await viewer.next()) as unknown as { binary: Buffer }).binary[1]!);
      expect(flags[0]).toBe(1 | 2);
      expect(flags.slice(1, -1).every((flag) => flag === 2)).toBe(true);
      const postures = new Set<unknown>();
      while (!postures.has('unfolded')) postures.add(((await tile.next()) as { posture?: string }).posture);
      expect([...postures]).toEqual(['folded', 'unfolded']);
      expect(helperRuns()).toEqual([]);
      expect(toolRuns().filter((run) => run.tool === 'xcrun')).toEqual([]);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)('sends JPEG frame events when no helper can encode video', async () => {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
      FAKE_FRAMES: JSON.stringify([jpeg(10, 20, 'A').toString('base64')]),
    });
    const client = await authed(port);
    expect(
      await client.request('frames.subscribe', { workspace, platform: 'ios', fps: 61, video: ['h264'] }),
    ).toMatchObject({ error: { code: 'bad-request' } });
    const reply = await client.request('frames.subscribe', { workspace, platform: 'ios', fps: 60, video: ['h264'] });
    expect(reply).toMatchObject({ result: { subscription: 's1' } });
    expect(reply).not.toHaveProperty('result.video');
    expect(await client.next()).toMatchObject({ event: 'frame', width: 10, height: 20 });
    expect(await client.request('frames.keyframe', { subscription: 's1' })).toMatchObject({
      error: { code: 'unknown-subscription' },
    });
    expect(await client.request('frames.subscribe', { workspace, platform: 'ios', video: 'h264' })).toMatchObject({
      error: { code: 'bad-request' },
    });
  });

  test.skipIf(!fakeTailscale)('falls back to screenshots when the helper fails before its first frame', async () => {
    const port = await startWithTools(
      {
        FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
        FAKE_FRAMES: JSON.stringify([jpeg(10, 20, 'A').toString('base64')]),
        FAKE_HELPER_FAIL: 'CoreSimulator could not be loaded.',
      },
      undefined,
      fakeHelper(),
    );
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios' });
    expect(await client.next()).toMatchObject({ event: 'frame', width: 10, height: 20 });
    expect(helperRuns()).toHaveLength(1);
    expect(toolRuns().some((run) => run.tool === 'xcrun')).toBe(true);
  });

  test.skipIf(!fakeTailscale)('ends the subscription when the helper fails after streaming', async () => {
    const port = await startWithTools(
      {
        FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM }),
        FAKE_FRAMES: '[]',
        FAKE_HELPER_INTERVAL_MS: '10',
        FAKE_HELPER_FAIL_AFTER: '3',
        FAKE_HELPER_FAIL: 'The simulator went away.',
      },
      undefined,
      fakeHelper(),
    );
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'ios', fps: 30 });
    let message = await client.next();
    while ('event' in message && message.event === 'frame') message = await client.next();
    expect(message).toEqual({
      event: 'error',
      subscription: 's1',
      error: { code: 'frames-failed', message: expect.stringContaining('The simulator went away.') },
    });
    expect(toolRuns().some((run) => run.tool === 'xcrun')).toBe(false);
  });

  test.skipIf(!fakeTailscale)(
    'preserves the displayed Duo revision and releases its gesture while read subscribers remain',
    async () => {
      const inputs = join(root, 'duo-inputs.ndjson');
      const port = await startControl({
        FAKE_STIM_PAYLOADS: statusWith({ ios: { ...OWNED_SIM, name: 'stim-test (iPhone Duo 27.1)' } }),
        FAKE_HELPER_INPUTS: inputs,
      });
      const viewer = await authed(port);
      await viewer.request('frames.subscribe', { workspace, platform: 'ios' });
      await viewer.next();
      const driver = await authed(port, true);
      const begun = await driver.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session } = begun.result as { session: string };
      const revision = '16ef79a2-5cef-4cdb-b5e9-ab09ef0722d2';
      const touch = { session, phase: 'down', x: 0.25, y: 0.75, duoRevision: revision };
      expect(await driver.request('input.touch', { ...touch, duoRevision: 'unbound' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await driver.request('input.touch', { ...touch, display: 0 })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await driver.request('input.touch', touch)).toMatchObject({ result: {} });
      driver.socket.close();
      await driver.closed;
      const commands = () =>
        existsSync(inputs)
          ? readFileSync(inputs, 'utf8')
              .split('\n')
              .slice(0, -1)
              .map((line) => JSON.parse(line))
          : [];
      await until(() => commands().some((command) => command.input === 'duo-release'));
      expect(commands()).toEqual([
        { input: 'touch', phase: 'down', x: 0.25, y: 0.75, duoRevision: revision },
        { input: 'touch', phase: 'up', x: 0.25, y: 0.75, duoRevision: revision },
        { input: 'duo-release' },
      ]);
      expect(alive(await readPid(`${toolCalls}.started`))).toBe(true);
      expect(await viewer.next()).toMatchObject({ event: 'frame' });
      viewer.socket.close();
    },
  );

  test.skipIf(!fakeTailscale)('sends a second finger to the helper and refuses half a pair', async () => {
    const inputs = join(root, 'two-finger-inputs.ndjson');
    const port = await startControl({ FAKE_HELPER_INPUTS: inputs });
    const driver = await authed(port, true);
    const begun = await driver.request('control.begin', { workspace, platform: 'ios' });
    if (!('result' in begun)) throw new Error(JSON.stringify(begun));
    const result: unknown = begun.result;
    assert(isJsonObject(result) && typeof result.session === 'string');
    const { session } = result;
    const touch = { session, phase: 'down', x: 0.25, y: 0.5, x2: 0.75, y2: 0.5 };
    expect(await driver.request('input.touch', touch)).toMatchObject({ result: {} });
    expect(await driver.request('input.touch', { ...touch, y2: undefined })).toMatchObject({
      error: { code: 'bad-request' },
    });
    expect(await driver.request('input.touch', { ...touch, y2: 2 })).toMatchObject({ error: { code: 'bad-request' } });
    expect(await driver.request('input.touch', { ...touch, phase: 'up' })).toMatchObject({ result: {} });
    const commands = () =>
      existsSync(inputs)
        ? readFileSync(inputs, 'utf8')
            .split('\n')
            .slice(0, -1)
            .map((line) => JSON.parse(line))
        : [];
    await until(() => commands().length === 2);
    expect(commands()).toEqual([
      { input: 'touch', phase: 'down', x: 0.25, y: 0.5, x2: 0.75, y2: 0.5, display: 0 },
      { input: 'touch', phase: 'up', x: 0.25, y: 0.5, x2: 0.75, y2: 0.5, display: 0 },
    ]);
    driver.socket.close();
    await driver.closed;
  });

  test.skipIf(!fakeTailscale)(
    'changes only advertised simulator options under the current control session',
    async () => {
      const port = await startControl({
        FAKE_SIMULATOR_OPTIONS: JSON.stringify({ canShake: true, slowAnimations: false }),
      });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session, simulator } = begun.result as { session: string; simulator: unknown };
      expect(simulator).toEqual({ canShake: true, slowAnimations: false });
      expect(
        await client.request('input.simulator', { session, action: 'slow-animations', enabled: true }),
      ).toMatchObject({ result: { canShake: true, slowAnimations: true } });
      expect(await client.request('input.simulator', { session, action: 'shake', enabled: true })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(
        await client.request('input.simulator', { session, action: 'slow-animations', enabled: 'true' }),
      ).toMatchObject({ error: { code: 'bad-request' } });
      expect(await client.request('input.simulator', { session, action: 'shake' })).toMatchObject({
        result: { canShake: true },
      });
      const stranger = await authed(port, true);
      expect(await stranger.request('input.simulator', { session, action: 'shake' })).toMatchObject({
        error: { code: 'unknown-session' },
      });
      expect(
        toolRuns()
          .filter((run) => run.args[0] === 'simulator-options')
          .map((run) => run.args.slice(2)),
      ).toEqual([['read'], ['slow-animations', 'on'], ['shake']]);
    },
  );

  test.skipIf(!fakeTailscale)(
    'hides unavailable simulator controls and refuses a mutation without capability',
    async () => {
      const port = await startControl({
        FAKE_SIMULATOR_OPTIONS: JSON.stringify({ canShake: false, slowAnimations: null }),
      });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session } = begun.result as { session: string };
      expect(await client.request('input.simulator', { session, action: 'shake' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(
        await client.request('input.simulator', { session, action: 'slow-animations', enabled: true }),
      ).toMatchObject({ error: { code: 'bad-request' } });
      expect(toolRuns().filter((run) => run.args[0] === 'simulator-options')).toHaveLength(1);
    },
  );

  test.skipIf(!fakeTailscale)('stops a pending simulator option when its control session ends', async () => {
    const port = await startControl({
      FAKE_SIMULATOR_OPTIONS: JSON.stringify({ canShake: true, slowAnimations: false }),
      FAKE_SIMULATOR_WAIT: '1',
    });
    const client = await authed(port, true);
    const begun = await client.request('control.begin', { workspace, platform: 'ios' });
    if (!('result' in begun)) throw new Error(JSON.stringify(begun));
    const { session } = begun.result as { session: string };
    const pending = client.request('input.simulator', { session, action: 'slow-animations', enabled: true });
    let pid = 0;
    await until(() => {
      if (!existsSync(`${toolCalls}.option-started`)) return false;
      pid = Number(readFileSync(`${toolCalls}.option-started`, 'utf8'));
      return Number.isSafeInteger(pid) && pid > 0;
    });
    expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
    expect(await pending).toMatchObject({ error: { code: 'action-failed' } });
    expect(() => process.kill(pid, 0)).toThrow('ESRCH');
  });

  test.skipIf(!fakeTailscale)('refuses control to a device paired read-only, and logs it', async () => {
    const port = await startControl();
    const client = await authed(port);
    expect(await client.request('control.begin', { workspace, platform: 'ios' })).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(await client.request('input.touch', { session: 'c1', phase: 'down', x: 0.5, y: 0.5 })).toMatchObject({
      error: { code: 'unknown-session' },
    });
    expect(readAudit()).toEqual([expect.objectContaining({ action: 'control.begin', ok: false })]);
    expect(lockCalls()).toEqual([]);
  });

  test.skipIf(!fakeTailscale)('refuses control of a physical iPhone, which is view only', async () => {
    const port = await startControl();
    const client = await authed(port, true);
    expect(await client.request('control.begin', { workspace, platform: 'ios', physical: true })).toMatchObject({
      error: { code: 'action-failed', message: expect.stringContaining('view only') },
    });
    expect(lockCalls()).toEqual([]);
  });

  test.skipIf(!fakeTailscale)(
    'sends input to the helper under a device lease and releases the lease when the session ends',
    async () => {
      const leaseFile = controlLease(workspace, 'SIM-1');
      const samePlatform = controlLease(workspace, 'SIM-2', 'ios', 'tablet');
      const otherPlatform = controlLease(workspace, 'EMULATOR', 'android');
      const foreign = controlLease(join(root, 'other'), 'FOREIGN');
      const port = await startControl({}, { shapeChangesPerSecond: 1 });
      const client = await authed(port, true);
      const begun = await client.request('control.begin', { workspace, platform: 'ios' });
      if (!('result' in begun)) throw new Error(JSON.stringify(begun));
      const { session, lease, postures } = begun.result as {
        session: string;
        lease: { expiresAt: string };
        postures: string[];
      };
      expect(lease.expiresAt).toEqual(expect.any(String));
      expect(postures).toEqual([]);
      await until(() => existsSync(`${toolCalls}.started`));
      expect(await client.request('input.touch', { session, phase: 'down', x: 0.25, y: 0.75 })).toMatchObject({
        result: {},
      });
      expect(await client.request('input.text', { session, text: 'Hi!\n' })).toMatchObject({ result: {} });
      expect(await client.request('input.button', { session, button: 'home' })).toMatchObject({ result: {} });
      expect(await client.request('input.rotate', { session, direction: 'left' })).toMatchObject({ result: {} });
      expect(await client.request('input.rotate', { session, direction: 'right' })).toMatchObject({
        error: { code: 'limit-exceeded', message: expect.stringContaining('rotate or fold') },
      });
      expect(await client.request('input.window', { session, window: null })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('input.button', { session, button: 'back' })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('input.posture', { session, posture: 'folded' })).toMatchObject({
        error: { code: 'bad-request', message: 'This device has no hinge.' },
      });
      expect(await client.request('input.text', { session, text: `caf${String.fromCharCode(233)}` })).toMatchObject({
        error: { code: 'bad-request' },
      });
      expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
      await until(() => helperRuns().length === 1);
      expect(helperRuns()[0]!.configs).toEqual([
        { fps: 0, maxEdge: 240, jpeg: false, video: false, bitrate: expect.any(Number) },
        { input: 'touch', phase: 'down', x: 0.25, y: 0.75, display: 0 },
        { input: 'text', text: 'Hi!\n' },
        { input: 'button', button: 'home' },
        { input: 'rotate', direction: 'left' },
        { input: 'touch', phase: 'up', x: 0.25, y: 0.75, display: 0 },
      ]);
      await until(() => !existsSync(leaseFile.path));
      expect(existsSync(samePlatform.path)).toBe(false);
      expect(existsSync(otherPlatform.path)).toBe(true);
      expect(existsSync(foreign.path)).toBe(true);
      expect(readWorkspaceState(workspace)?.deviceLeases).toMatchObject({ android: { id: 'EMULATOR' } });
      expect(lockCalls()).toEqual(['device lock ios SIM-1 --for 2m --wait 0 --json']);
      expect(readAudit().map((record) => record.action)).toEqual(['control.begin', 'control.end']);
    },
    10_000,
  );

  test.skipIf(!fakeTailscale)(
    'isolates two hosts returning c1 from each other and from local c1',
    async () => {
      const hosts: WebSocketServer[] = [];
      const hostKeys: string[] = [];
      const seen: { method: string; params: Record<string, unknown> }[][] = [[], []];
      const sessions = ['12345678-1234-1234-1234-123456789abc', '12345678-1234-1234-1234-123456789def'];
      const paths = [join(root, 'hosted-a'), join(root, 'hosted-b')];
      try {
        for (const [index, session] of sessions.entries()) {
          const host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
          hosts.push(host);
          await new Promise<void>((resolve, reject) => {
            host.once('listening', resolve);
            host.once('error', reject);
          });
          const hostKey = generateNoiseKeyPair();
          hostKeys.push(hostKey.publicKey.toString('base64url'));
          host.on('connection', (raw) =>
            raw.once('message', async (first, isBinary) => {
              const { socket } = await acceptNoise(raw, first, isBinary, {
                keyPair: hostKey,
                psk: () => null,
                timeoutMs: 5000,
              });
              socket.on('message', (data: Buffer) => {
                const request = JSON.parse(data.toString()) as {
                  id: number;
                  method: string;
                  params: Record<string, unknown>;
                };
                seen[index]!.push(request);
                let result: Record<string, unknown> = {};
                if (request.method === 'hello') {
                  if (request.params.access !== 'device-host') return socket.close();
                  result = { capabilities: ['device-host'], peer: PEER };
                } else if (request.method === 'device-host.control.begin') {
                  if (request.params.session !== session) return socket.close();
                  result = { session: 'c1', platform: 'macos', lease: null, postures: [] };
                } else if (request.params.session !== 'c1') return socket.close();
                socket.send(JSON.stringify({ id: request.id, result }));
              });
            }),
          );
          const path = paths[index]!;
          mkdirSync(path);
          mkdirSync(workspaceStateDir(path), { recursive: true });
          writeFileSync(
            join(workspaceStateDir(path), 'state.json'),
            JSON.stringify({
              macos: {
                ...OWNED_MACOS,
                app: undefined,
                host: {
                  machine: `mini-${index}`,
                  session,
                  appSlot: 1,
                  appAttempt: 'app',
                  bundleId: 'com.app.hosted1',
                  agent: { driver: 'none', setting: 'hosting.agentDriver' },
                },
              },
            }),
          );
        }
        writeFileSync(
          join(process.env.STIM_HOME!, 'config.json'),
          JSON.stringify({ projects: { [workspace]: {}, [paths[0]!]: {}, [paths[1]!]: {} } }),
        );
        writeFileSync(
          join(process.env.STIM_HOME!, 'device-host-machines.json'),
          JSON.stringify({
            version: 2,
            machines: sessions.map((_, index) => ({
              machine: `mini-${index}`,
              transport: 'tailscale',
              address: `mini-${index}.tail.ts.net`,
              deviceId: `device-${index}`,
              serverKey: hostKeys[index],
              state: 'approved',
              requestedAt: new Date().toISOString(),
            })),
          }),
        );
        const port = await startControl(
          { FAKE_STIM_PAYLOADS: statusWith({ macos: OWNED_MACOS }) },
          undefined,
          undefined,
          {
            status: () => ({
              Peer: Object.fromEntries(
                sessions.map((_, index) => [
                  index,
                  {
                    ID: `node-${index}`,
                    DNSName: `mini-${index}.tail.ts.net.`,
                    TailscaleIPs: [`100.64.0.${index + 8}`],
                  },
                ]),
              ),
            }),
            endpoint: (found) => ({
              ...found,
              url: `ws://127.0.0.1:${(hosts[found.servername.startsWith('mini-0.') ? 0 : 1]!.address() as { port: number }).port}`,
            }),
          },
        );
        const client = await authed(port, true);
        const ids: string[] = [];
        for (const path of [...paths, workspace]) {
          const reply = await client.request('control.begin', { workspace: path, platform: 'macos' });
          expect(reply).toHaveProperty('result.session');
          ids.push((reply as { result: { session: string } }).result.session);
        }
        expect(ids).toEqual(['h1', 'h2', 'c1']);
        for (const [index, session] of ids.entries()) {
          expect(await client.request('input.text', { session, text: `target-${index}` })).toMatchObject({
            result: {},
          });
          expect(await client.request('control.end', { session })).toMatchObject({ result: {} });
        }
        for (const index of [0, 1]) {
          expect(
            seen[index]!.filter((request) => request.method === 'device-host.input.text').map(
              (request) => request.params,
            ),
          ).toEqual([{ session: 'c1', text: `target-${index}` }]);
          expect(
            seen[index]!.filter((request) => request.method === 'device-host.control.end').map(
              (request) => request.params,
            ),
          ).toEqual([{ session: 'c1' }]);
        }
        expect(
          readAudit()
            .filter((record) => record.action === 'control.end')
            .map((record) => record.workspace)
            .toSorted(),
        ).toEqual([...paths, workspace].toSorted());
      } finally {
        for (const host of hosts) {
          for (const socket of host.clients) socket.terminate();
          await new Promise<void>((resolve) => host.close(() => resolve()));
        }
      }
    },
    10_000,
  );
});
