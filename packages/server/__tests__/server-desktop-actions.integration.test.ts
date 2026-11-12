import {
  CLIENT,
  root,
  workspace,
  server,
  reloadBrowser,
  start,
  connect,
  pair,
  desktop,
  until,
  stimCalls,
  authed,
  forgetServer,
} from './server-harness.ts';
import assert from 'node:assert';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { delimiter, dirname, join } from 'node:path';
import { readWorkspaceState, isJsonObject, loadConfig } from '@stim-cli/core/state';
import { createStim } from 'stim';
import * as stim from 'stim';
import * as stimSelf from 'stim/internal/api-self';
import { protocolJsonSchema, type ServerMessage } from '../src/protocol.ts';
import Ajv2020 from 'ajv/dist/2020.js';
import { readAudit } from '../src/actions.ts';
import { localConnect, type Client } from './noise-client.ts';
import { workspaceName, workspaceStateDir } from '@stim-cli/core';
import { captureProcessToken, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { readPid } from './pid-file.ts';

describe.skipIf(process.platform === 'win32')('Desktop settings writes', () => {
  it('writes and unsets through the proved Desktop without a CLI and keeps secrets out of results and audit', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    await start();
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    expect(
      await client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'set',
        key: 'ios.runtime',
        value: '26.4',
        scope: 'workspace',
      }),
    ).toMatchObject({
      result: { changed: true, setting: { value: '26.4', origin: 'workspace' } },
    });
    const secret = 'private-setting-value';
    const written = await client.request('desktop.settings.write', {
      cwd: workspace,
      action: 'set',
      key: 'android.keystorePassword',
      value: secret,
      scope: 'workspace',
    });
    expect(written).toMatchObject({ result: { setting: { value: '********', layers: { workspace: '********' } } } });
    expect(JSON.stringify(written)).not.toContain(secret);
    expect(
      await client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'unset',
        key: 'ios.runtime',
        scope: 'workspace',
      }),
    ).toMatchObject({
      result: { changed: true, setting: { layers: {} } },
    });
    expect(loadConfig()?.projects[workspace]?.settings).toEqual({ android: { keystorePassword: secret } });
    expect(readAudit()).toContainEqual(
      expect.objectContaining({ action: 'settings.set', setting: 'android.keystorePassword', workspace, ok: true }),
    );
    expect(JSON.stringify(readAudit())).not.toContain(secret);
    expect(stimCalls()).toEqual([]);
  });

  it('requires the proved local Desktop and refuses malformed requests without mutation', async () => {
    const port = await start();
    const remote = await authed(port, true);
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    const request = { cwd: workspace, action: 'set', key: 'concurrency.maxBuilds', value: '3' };
    for (const client of [remote, plain]) {
      expect(await client.request('desktop.settings.write', request)).toHaveProperty('error.code', 'forbidden');
    }
    const client = await desktop();
    for (const params of [
      {},
      { ...request, cwd: '.' },
      { ...request, cwd: workspace + '\0' },
      { ...request, cwd: join(root, 'missing') },
      { ...request, action: 'unset' },
      { ...request, value: false },
      { ...request, extra: true },
      { ...request, scope: 'all' },
    ]) {
      expect(await client.request('desktop.settings.write', params)).toHaveProperty('error.code', 'bad-request');
    }
    expect(loadConfig()?.concurrency?.maxBuilds).toBeUndefined();
    expect(stimCalls()).toEqual([]);
  });

  it('accepts a non-project folder for machine writes and preserves typed refusals', async () => {
    await start();
    const client = await desktop();
    expect(
      await client.request('desktop.settings.write', {
        cwd: root,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: '3',
      }),
    ).toMatchObject({ result: { changed: true, setting: { value: 3 } } });
    expect(
      await client.request('desktop.settings.write', {
        cwd: root,
        action: 'set',
        key: 'ios.runtime',
        value: '26.4',
        scope: 'workspace',
      }),
    ).toMatchObject({ result: { code: 'STIM_NO_PROJECT', remedy: expect.any(String) } });
    expect(
      await client.request('desktop.settings.write', {
        cwd: root,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: 'many',
      }),
    ).toMatchObject({ result: { code: 'STIM_BAD_ARG', message: expect.any(String) } });
    expect(loadConfig()?.concurrency?.maxBuilds).toBe(3);
  });
  it('keeps a canonical folder busy while yielding and cancels a timed-out pending write', async () => {
    await start({ actionLimits: { timeoutMs: 1000 } });
    const client = await desktop();
    const lock = tryAcquireClaim({ root: join(root, 'home', 'config.lock.claims'), mode: 'exclusive' }).acquired;
    assert(lock);
    const alias = join(root, 'alias');
    symlinkSync(workspace, alias, 'dir');
    const request = { cwd: alias, action: 'set', key: 'concurrency.maxBuilds', value: '3' };
    try {
      const pending = client.request('desktop.settings.write', request);
      expect(await client.request('machine.history')).toHaveProperty('result');
      expect(await client.request('desktop.settings.write', { ...request, cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      expect(await pending).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining('did not finish within') },
      });
      await until(() => readAudit().some((entry) => entry.action === 'settings.set'));
      expect(loadConfig()?.concurrency?.maxBuilds).toBeUndefined();
      releaseClaim(lock);
      expect(await client.request('desktop.settings.write', request)).toHaveProperty('result.changed', true);
    } finally {
      releaseClaim(lock);
    }
  });

  it('cancels a pending write on disconnect without changing its setting', async () => {
    await start();
    const client = await desktop();
    const lock = tryAcquireClaim({ root: join(root, 'home', 'config.lock.claims'), mode: 'exclusive' }).acquired;
    assert(lock);
    try {
      void client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: '3',
      });
      expect(await client.request('machine.history')).toHaveProperty('result');
      client.socket.close();
      await client.closed;
      await until(() => readAudit().some((entry) => entry.action === 'settings.set'));
      expect(readAudit()).toContainEqual(
        expect.objectContaining({
          action: 'settings.set',
          ok: false,
          error: { code: 'action-failed', message: 'STIM_CANCELLED' },
        }),
      );
      expect(loadConfig()?.concurrency?.maxBuilds).toBeUndefined();
    } finally {
      releaseClaim(lock);
    }
  });

  it('bounds result output without leaking setting values into the audit', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    await start({ actionLimits: { maxOutputBytes: 8 } });
    const client = await desktop();
    const secret = 'not-for-the-audit';
    expect(
      await client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'set',
        key: 'android.keystorePassword',
        value: secret,
        scope: 'workspace',
      }),
    ).toHaveProperty('error.code', 'action-failed');
    expect(loadConfig()?.projects[workspace]?.settings).toEqual({ android: { keystorePassword: secret } });
    expect(
      await client.request('desktop.settings.write', {
        cwd: workspace,
        action: 'set',
        key: 'concurrency.maxBuilds',
        value: 'invalid-value'.repeat(100),
      }),
    ).toMatchObject({ error: { code: 'action-failed', message: 'Settings write exceeded its output limit.' } });
    expect(JSON.stringify(readAudit())).not.toContain(secret);
  });

  it('holds admission and shutdown until a committed recording deletion drains after timeout', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    const selected = join(workspace, 'src');
    mkdirSync(selected);
    const sibling = join(workspace, 'tests');
    mkdirSync(sibling);
    const recordings = join(workspaceStateDir(workspace), 'recordings');
    mkdirSync(recordings, { recursive: true });
    writeFileSync(join(recordings, 'segment'), 'recorded bytes');
    await start({ actionLimits: { timeoutMs: 1000 } });
    const client = await desktop();
    const other = await desktop();
    let started: () => void = () => {};
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = fsPromises.rm;
    const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (path === recordings) {
        started();
        await blocked;
      }
      return remove(path, options);
    });
    syncBuiltinESMExports();
    let closing: Promise<void> | undefined;
    try {
      const pending = client.request('desktop.settings.write', {
        cwd: selected,
        action: 'set',
        key: 'recording.enabled',
        value: 'false',
        scope: 'workspace',
      });
      await ready;
      expect(await pending).toHaveProperty('error.code', 'action-failed');
      for (const cwd of [workspace, sibling]) {
        expect(
          await other.request('desktop.settings.write', {
            cwd,
            action: 'unset',
            key: 'recording.enabled',
            scope: 'workspace',
          }),
        ).toHaveProperty('error.code', 'action-busy');
      }
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      assert(server);
      let closed = false;
      closing = server.close().then(() => {
        closed = true;
        return undefined;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      release();
      await closing;
      forgetServer();
      expect(existsSync(recordings)).toBe(false);
      expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'settings.set', ok: false }));
    } finally {
      release();
      await closing;
      deletion.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

describe.skipIf(process.platform === 'win32')('Desktop stop', () => {
  async function stopped(client: Client) {
    const progress: ServerMessage[] = [];
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-stop-ended') return { progress, done: message };
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
      progress.push(message);
    }
  }

  function heldConfig() {
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: {} }));
    const lock = tryAcquireClaim({ root: join(root, 'home', 'config.lock.claims'), mode: 'exclusive' }).acquired;
    assert(lock);
    return lock;
  }

  it('streams stop progress and the resolved workspace JSON without a CLI process', async () => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    const selected = join(workspace, 'src');
    mkdirSync(selected);
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: {} }));
    await start();
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    const reply = await client.request('desktop.stop.subscribe', { cwd: selected });
    expect(reply).toMatchObject({ result: { subscription: expect.any(String) } });
    const { progress, done } = await stopped(client);
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
    expect([...progress, done].every((message) => acceptsEvent(message))).toBe(true);
    expect(progress).toContainEqual(
      expect.objectContaining({
        event: 'desktop-stop-progress',
        stream: 'stderr',
        message: expect.stringContaining('no supervisor'),
      }),
    );
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ root: workspace, ok: true });
    expect(done.message).toContain('Stopped');
    expect(readWorkspaceState(workspace)?.launches).toBeUndefined();
    expect(stimCalls()).toEqual([]);
  });

  it('requires the proved local Desktop and rejects invalid targets before starting work', async () => {
    const port = await start();
    const remote = await authed(port, true);
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    for (const client of [remote, plain]) {
      expect(await client.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'forbidden',
      );
    }
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, extra: true },
      { cwd: `${workspace}\0` },
      { cwd: workspace, slot: '' },
      { cwd: workspace, slot: '../default' },
      { cwd: workspace, slot: 'constructor' },
      { cwd: join(root, 'missing') },
    ]) {
      expect(await client.request('desktop.stop.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    }
    expect(stimCalls()).toEqual([]);
  });

  it('stops one device slot while preserving sibling launches and the shared server reservation', async () => {
    writeFileSync(
      join(root, 'home', 'config.json'),
      JSON.stringify({
        projects: { [workspace]: { metroPort: 31337, deviceSlots: { tablet: {} } } },
      }),
    );
    const launch = {
      appId: 'dev.fixture',
      deviceId: 'fixture',
      metroPort: 31337,
      release: false,
      launchedAt: new Date().toISOString(),
    };
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: { ios: launch, 'ios:tablet': launch } }));
    await start();
    const client = await desktop();
    await client.request('desktop.stop.subscribe', { cwd: workspace, slot: 'tablet' });
    const { done } = await stopped(client);
    expect(done.exitCode).toBe(0);
    expect(readWorkspaceState(workspace)?.launches).toEqual({ ios: launch });
    expect(loadConfig()?.projects?.[workspace]?.metroPort).toBe(31337);
    expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'stop', slot: 'tablet', ok: true }));
    expect(stimCalls()).toEqual([]);
  });

  it('accepts the web slot without clearing native launches or the shared server reservation', async () => {
    writeFileSync(
      join(root, 'home', 'config.json'),
      JSON.stringify({ projects: { [workspace]: { metroPort: 31337 } } }),
    );
    const state = join(workspaceStateDir(workspace), 'state.json');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ launches: { ios: { appId: 'dev.fixture' } } }));
    await start();
    const client = await desktop();
    await client.request('desktop.stop.subscribe', { cwd: workspace, slot: 'web' });
    const { done } = await stopped(client);
    expect(done.exitCode).toBe(0);
    expect(readWorkspaceState(workspace)?.launches).toEqual({ ios: { appId: 'dev.fixture' } });
    expect(loadConfig()?.projects?.[workspace]?.metroPort).toBe(31337);
    expect(stimCalls()).toEqual([]);
  });

  it('keeps a timed-out stop busy until started cleanup drains at shutdown', async () => {
    const port = await start({ actionLimits: { timeoutMs: 500 } });
    const client = await desktop();
    const other = await authed(port, true);
    const lock = heldConfig();
    let released = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      await client.request('desktop.stop.subscribe', { cwd: workspace });
      await until(() => readWorkspaceState(workspace)?.launches === undefined);
      const { done } = await stopped(client);
      expect(done).toMatchObject({ exitCode: 1, message: 'stim stop did not finish within 0.5 s.' });
      expect(await other.request('action', { action: 'reload', workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      expect(await other.request('machine.history')).toHaveProperty('result');
      release = setTimeout(() => {
        released = true;
        releaseClaim(lock);
      }, 50);
      assert(server);
      await server.close();
      forgetServer();
      expect(released).toBe(true);
    } finally {
      clearTimeout(release);
      releaseClaim(lock);
    }
  });

  it.each(['unsubscribe', 'disconnect'])(
    'cancels on %s and retains admission until started cleanup finishes',
    async (mode) => {
      const port = await start();
      const client = await desktop();
      const other = await authed(port, true);
      const lock = heldConfig();
      try {
        const reply = await client.request('desktop.stop.subscribe', { cwd: workspace });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result) && typeof result.subscription === 'string');
        await until(() => readWorkspaceState(workspace)?.launches === undefined);
        if (mode === 'unsubscribe') {
          await client.request('unsubscribe', { subscription: result.subscription });
        } else {
          client.socket.close();
          await client.closed;
        }
        expect(await other.request('action', { action: 'reload', workspace })).toHaveProperty(
          'error.code',
          'action-busy',
        );
        releaseClaim(lock);
        await until(() =>
          readAudit().some((entry) => entry.action === 'stop' && entry.error?.message.includes('STIM_CANCELLED')),
        );
        expect(stimCalls()).toEqual([]);
      } finally {
        releaseClaim(lock);
      }
    },
  );

  it('bounds streamed output and drains cancellation before closing the server', async () => {
    await start({ actionLimits: { maxOutputBytes: 1 } });
    const client = await desktop();
    await client.request('desktop.stop.subscribe', { cwd: workspace });
    const { progress, done } = await stopped(client);
    expect(progress).toEqual([]);
    expect(done).toMatchObject({ exitCode: 1, stdout: '', message: 'stim stop printed more than 1 bytes.' });
    assert(server);
    await server.close();
    forgetServer();
    expect(readAudit()).toContainEqual(
      expect.objectContaining({
        action: 'stop',
        error: { code: 'action-failed', message: 'stim stop printed more than 1 bytes.' },
      }),
    );
    expect(stimCalls()).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('Desktop start', () => {
  async function started(client: Client) {
    const progress: ServerMessage[] = [];
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-start-ended') return { progress, done: message };
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
      progress.push(message);
    }
  }

  it.each(['start', 'stop', 'action-stop'] as const)(
    'reserves the enclosing app while %s is pending',
    async (first) => {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
      const selected = join(workspace, 'src');
      const sibling = join(workspace, 'tests');
      mkdirSync(selected);
      mkdirSync(sibling);
      mkdirSync(workspaceStateDir(workspace), { recursive: true });
      writeFileSync(join(workspaceStateDir(workspace), 'state.json'), JSON.stringify({ launches: {} }));
      writeFileSync(
        join(root, 'home', 'config.json'),
        JSON.stringify({ projects: { [workspace]: {}, [selected]: {} } }),
      );
      const port = await start({ actionLimits: { timeoutMs: 1000 } });
      const client = first === 'action-stop' ? await authed(port, true) : await desktop();
      const other = await desktop();
      let controlStop: Promise<ServerMessage> | undefined;
      const claim = tryAcquireClaim({ root: join(root, 'home', 'config.lock.claims'), mode: 'exclusive' });
      assert(claim.acquired);
      try {
        if (first === 'action-stop') controlStop = client.request('action', { action: 'stop', workspace: selected });
        else {
          const reply = await client.request(`desktop.${first}.subscribe`, { cwd: selected });
          assert('result' in reply);
        }
        const lock = join(workspaceStateDir(workspace), first === 'start' ? 'metro-start.lock' : 'native-run.lock');
        await until(() => readClaimSet(lock).live.length > 0);
        const second = first === 'start' ? 'stop' : 'start';
        expect(
          await other.request(`desktop.${second}.subscribe`, {
            cwd: sibling,
            ...(second === 'stop' ? { slot: 'web' } : {}),
          }),
        ).toHaveProperty('result.subscription');
        let terminal: ServerMessage | undefined;
        while (!terminal) {
          const event = await other.next();
          if ('event' in event && event.event === `desktop-${second}-ended`) terminal = event;
        }
        expect(terminal).toMatchObject({ exitCode: 1, message: expect.stringContaining('STIM_ACTION_BUSY') });
      } finally {
        releaseClaim(claim.acquired);
        await controlStop;
      }
    },
  );

  it.each(['unsubscribe', 'deadline', 'retained-unsubscribe'] as const)(
    'waits for startup cleanup before acknowledging %s',
    async (mode) => {
      const claim = tryAcquireClaim({ root: join(root, 'draining-start'), mode: 'exclusive' });
      assert(claim.acquired);
      const heldClaim = claim.acquired;
      await start({ actionLimits: { timeoutMs: mode === 'deadline' ? 100 : 5000 } });
      let markCancelled = () => {};
      const cancelled = new Promise<void>((resolve) => {
        markCancelled = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = stimSelf.createStim;
      const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
        ...original(options),
        start: async (request) => {
          const signal = request?.signal;
          assert(signal);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          markCancelled();
          await gate;
          throw new stim.StimError(
            mode !== 'unsubscribe'
              ? {
                  code: 'STIM_CLAIM_UNAVAILABLE',
                  message: 'Fixture cleanup is unresolved.',
                  remedy: `Recover ${heldClaim.path}`,
                  details: { cause: { retainedClaimRoots: [heldClaim.root] } },
                }
              : { code: 'STIM_CANCELLED', message: 'Fixture startup cancelled.' },
          );
        },
      }));
      try {
        const client = await desktop();
        const other = await desktop();
        const reply = await client.request('desktop.start.subscribe', { cwd: workspace });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result));
        let acknowledged = false;
        const response =
          mode === 'deadline' ? started(client) : client.request('unsubscribe', { subscription: result.subscription });
        void response.then(() => {
          acknowledged = true;
          return undefined;
        });
        await cancelled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
          'error.code',
          'action-busy',
        );
        expect(acknowledged).toBe(false);
        release();
        const answer = await response;
        const recoveryMessage = expect.stringContaining(`Recover ${heldClaim.path}`);
        const expected =
          mode === 'deadline'
            ? { code: 'STIM_CLAIM_UNAVAILABLE', remedy: `Recover ${heldClaim.path}` }
            : mode === 'retained-unsubscribe'
              ? { error: { code: 'action-failed', message: recoveryMessage } }
              : { result: {} };
        expect('done' in answer ? JSON.parse(answer.done.stdout) : answer).toMatchObject(expected);
        const subscription = expect.any(String);
        expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toMatchObject(
          mode !== 'unsubscribe' ? { error: { code: 'action-busy' } } : { result: { subscription } },
        );
      } finally {
        release();
        api.mockRestore();
        releaseClaim(claim.acquired);
      }
    },
  );

  it('releases retained workspace and connection admission after every recorded claim is recovered', async () => {
    const nested = join(workspace, 'src');
    mkdirSync(nested);
    const sibling = join(workspace, 'tests');
    mkdirSync(sibling);
    const roots = [nested, ...[1, 2, 3].map((index) => join(root, `retained-app-${index}`))];
    for (const cwd of roots) {
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(cwd === nested ? workspace : cwd, 'package.json'),
        JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }),
      );
    }
    const claims = roots.map((_cwd, index) => {
      const attempt = tryAcquireClaim({ root: join(root, `retained-${index}`), mode: 'exclusive' });
      assert(attempt.acquired);
      return attempt.acquired;
    });
    const second = tryAcquireClaim({ root: join(root, 'retained-second'), mode: 'exclusive' });
    assert(second.acquired);
    const secondClaim = second.acquired;
    const firstClaim = claims[0];
    assert(firstClaim);
    await start({ requestLimits: { connection: 4 } });
    const original = stimSelf.createStim;
    const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
      ...original(options),
      start: (request) =>
        original(options).start({
          ...request,
          beforeStart: (resolved) => {
            request?.beforeStart?.(resolved);
            const index = roots.indexOf(options.projectRoot);
            const current = claims[index];
            assert(current);
            const retained = index === 0 ? [firstClaim, secondClaim] : [current];
            if (retained.some((claim) => existsSync(claim.path)))
              throw new stim.StimError({
                code: 'STIM_CLAIM_UNAVAILABLE',
                message: 'Fixture child cleanup could not be confirmed.',
                details: { retainedClaimRoots: retained.map((claim) => claim.root) },
              });
            throw new stim.StimError({ code: 'STIM_BAD_ARG', message: 'Recovered startup reached the API.' });
          },
        }),
    }));
    try {
      const client = await desktop();
      const other = await desktop();
      for (const cwd of roots) {
        expect(await client.request('desktop.start.subscribe', { cwd })).toHaveProperty('result.subscription');
        expect(JSON.parse((await started(client)).done.stdout)).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      }
      await until(() => readAudit().filter((entry) => entry.action === 'start').length === 4);
      expect(await client.request('desktop.start.subscribe', { cwd: nested })).toHaveProperty(
        'error.code',
        'limit-exceeded',
      );
      releaseClaim(claims[0]);
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      expect(await other.request('desktop.stop.subscribe', { cwd: sibling, slot: 'web' })).toHaveProperty(
        'result.subscription',
      );
      let terminal: ServerMessage | undefined;
      while (!terminal) {
        const event = await other.next();
        if ('event' in event && event.event === 'desktop-stop-ended') terminal = event;
      }
      expect(terminal).toMatchObject({ exitCode: 1, message: expect.stringContaining('STIM_ACTION_BUSY') });
      releaseClaim(second.acquired);
      expect(
        await other.request('desktop.settings.write', {
          cwd: workspace,
          action: 'set',
          key: 'recording.enabled',
          value: 'false',
          scope: 'workspace',
        }),
      ).toHaveProperty('result');
      expect(await client.request('desktop.start.subscribe', { cwd: nested })).toHaveProperty('result.subscription');
      expect(JSON.parse((await started(client)).done.stdout)).toMatchObject({ code: 'STIM_BAD_ARG' });
    } finally {
      api.mockRestore();
      for (const claim of [...claims, second.acquired]) releaseClaim(claim);
    }
  });

  it('streams the real supervisor failure diagnostic before the typed startup refusal', async () => {
    const listener = createHttpServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert(address && typeof address === 'object');
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    writeFileSync(
      join(root, 'home', 'config.json'),
      JSON.stringify({ projects: { [workspace]: { metroPort: address.port } } }),
    );
    const tools = join(root, 'tools');
    mkdirSync(tools);
    writeFileSync(join(tools, 'lsof'), '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
    const script = join(workspace, 'broken-metro.mjs');
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    writeFileSync(script, "console.error('Error: fixture Metro diagnostic: port setup rejected'); process.exit(1);");
    writeFileSync(
      join(workspace, '.stim.json'),
      JSON.stringify({ metro: { command: [process.execPath, script, '{port}'], tunnel: 'off' } }),
    );
    await start({ env: { PATH: [tools, process.env.PATH ?? ''].join(delimiter) } });
    const client = await desktop();
    await client.request('desktop.start.subscribe', { cwd: workspace, waitSeconds: 5 });
    const { progress, done } = await started(client);
    expect(done.exitCode).toBe(1);
    expect(JSON.parse(done.stdout)).toMatchObject({ code: 'STIM_SUPERVISOR_EXITED' });
    expect(progress).toContainEqual(
      expect.objectContaining({
        event: 'desktop-start-progress',
        stream: 'stderr',
        message: expect.stringContaining('fixture Metro diagnostic: port setup rejected'),
      }),
    );
    expect(stimCalls()).toEqual([]);
  });

  it('starts and reuses an owned real supervisor without a CLI', async () => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    const script = join(workspace, 'metro.mjs');
    writeFileSync(
      script,
      "import {createServer} from 'node:http'; createServer((req,res)=>res.end('packager-status:running')).listen(Number(process.argv[2]), '127.0.0.1');",
    );
    const listener = createHttpServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    assert(address && typeof address === 'object');
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const home = join(root, 'home');
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        version: 2,
        projects: {
          [workspace]: {
            metroPort: address.port,
            settings: { metro: { command: [process.execPath, script, '{port}'] } },
          },
        },
        repos: {},
      }),
    );
    await start();
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    try {
      expect(await client.request('desktop.start.subscribe', { cwd: workspace, waitSeconds: 10 })).toHaveProperty(
        'result.subscription',
      );
      const first = await started(client);
      expect(first.done.exitCode).toBe(0);
      const facts: unknown = JSON.parse(first.done.stdout);
      assert(isJsonObject(facts));
      expect(facts).toMatchObject({ port: address.port, alreadyRunning: false, supervisorPid: expect.any(Number) });
      const record = readWorkspaceState(workspace)?.supervisor;
      expect(record?.pid).toBe(facts.supervisorPid);
      expect(inspectProcessIdentity(record)).toBe('same');
      await until(() => readAudit().some((entry) => entry.action === 'start' && entry.ok));
      expect(await client.request('desktop.start.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
      const reused = await started(client);
      expect(reused.done.exitCode).toBe(0);
      expect(JSON.parse(reused.done.stdout)).toMatchObject({
        supervisorPid: facts.supervisorPid,
        alreadyRunning: true,
      });
      const validator = new Ajv2020({ strict: false, validateFormats: false });
      validator.addSchema(protocolJsonSchema(), 'protocol');
      const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
      expect(
        [...first.progress, first.done, ...reused.progress, reused.done].every((message) => acceptsEvent(message)),
      ).toBe(true);
      expect(stimCalls()).toEqual([]);
    } finally {
      await createStim({ projectRoot: workspace, home }).stop();
    }
  }, 30_000);
  it('requires private Desktop proof and rejects invalid startup options before effects', async () => {
    const port = await start();
    const peer = await pair(port, undefined, true);
    const remote = await connect(port, undefined, { keyPair: peer.keyPair });
    await remote.request('hello', { client: CLIENT });
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    for (const client of [plain, remote])
      expect(await client.request('desktop.start.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'forbidden',
      );
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, extra: true },
      { cwd: `${workspace}\0` },
      { cwd: join(root, 'missing') },
      { cwd: workspace, remote: 'true' },
      { cwd: workspace, resetCache: 1 },
      { cwd: workspace, waitSeconds: 0 },
      { cwd: workspace, waitSeconds: -1 },
      { cwd: workspace, waitSeconds: 1.5 },
    ])
      expect(await client.request('desktop.start.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    expect(stimCalls()).toEqual([]);
    expect(readWorkspaceState(workspace)?.supervisor).toBeUndefined();
  });

  it.each(['unsubscribe', 'disconnect', 'deadline', 'server close'])(
    'reserves the resolved app and drains %s while its metadata lock is held',
    async (mode) => {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
      const nested = join(workspace, 'src');
      mkdirSync(nested);
      await start(mode === 'deadline' ? { actionLimits: { timeoutMs: 500 } } : {});
      const client = await desktop();
      const other = await desktop();
      const attempt = tryAcquireClaim({
        root: join(root, 'home', 'config.lock.claims'),
        mode: 'exclusive',
        label: 'fixture metadata',
      });
      assert(attempt.acquired);
      try {
        const reply = await client.request('desktop.start.subscribe', { cwd: nested });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result) && typeof result.subscription === 'string');
        for (const [method, params] of [
          ['desktop.stop.subscribe', { cwd: workspace }],
          ['desktop.reload.subscribe', { cwd: workspace }],
          [
            'desktop.settings.write',
            { cwd: workspace, action: 'set', key: 'recording.enabled', value: 'false', scope: 'workspace' },
          ],
        ] as const)
          expect(await other.request(method, params)).toHaveProperty('error.code', 'action-busy');
        expect(await other.request('machine.history')).toHaveProperty('result');
        if (mode === 'unsubscribe') await client.request('unsubscribe', { subscription: result.subscription });
        else if (mode === 'disconnect') {
          client.socket.close();
          await client.closed;
        } else if (mode === 'deadline') await started(client);
        else {
          assert(server);
          await server.close();
          forgetServer();
        }
        await until(() => readAudit().some((entry) => entry.action === 'start'));
        expect(readAudit().find((entry) => entry.action === 'start')).toMatchObject({
          workspace,
          ok: false,
          error: { message: mode === 'deadline' ? 'STIM_METRO_TIMEOUT' : 'STIM_CANCELLED' },
        });
        expect(readWorkspaceState(workspace)?.supervisor).toBeUndefined();
        expect(stimCalls()).toEqual([]);
      } finally {
        releaseClaim(attempt.acquired);
      }
    },
  );
  it('bounds typed startup refusals by the connection output budget', async () => {
    await start({ actionLimits: { maxOutputBytes: 1 } });
    const client = await desktop();
    await client.request('desktop.start.subscribe', { cwd: workspace });
    expect((await started(client)).done).toMatchObject({ exitCode: 1, stdout: '' });
    await until(() => readAudit().some((entry) => entry.action === 'start'));
    expect(readAudit().find((entry) => entry.action === 'start')?.error?.message).toBe('STIM_OUTPUT_LIMIT');
    expect(stimCalls()).toEqual([]);
  });

  it('limits a connection to four startup operations while they wait for metadata', async () => {
    const roots = [workspace, ...[1, 2, 3].map((index) => join(root, `app-${index}`))];
    for (const folder of roots) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    }
    await start({ requestLimits: { connection: 4 } });
    const client = await desktop();
    const attempt = tryAcquireClaim({
      root: join(root, 'home', 'config.lock.claims'),
      mode: 'exclusive',
      label: 'fixture metadata',
    });
    assert(attempt.acquired);
    try {
      const subscriptions: string[] = [];
      for (const cwd of roots) {
        const reply = await client.request('desktop.start.subscribe', { cwd });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result) && typeof result.subscription === 'string');
        subscriptions.push(result.subscription);
      }
      expect(await client.request('desktop.start.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'limit-exceeded',
      );
      for (const subscription of subscriptions) await client.request('unsubscribe', { subscription });
      await until(() => readAudit().filter((entry) => entry.action === 'start').length === 4);
      expect(
        readAudit()
          .filter((entry) => entry.action === 'start')
          .every((entry) => entry.error?.message === 'STIM_CANCELLED'),
      ).toBe(true);
      expect(stimCalls()).toEqual([]);
    } finally {
      releaseClaim(attempt.acquired);
    }
  });
});

describe.skipIf(process.platform === 'win32')('Desktop reload', () => {
  async function reloaded(client: Client) {
    const progress: ServerMessage[] = [];
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-reload-ended') return { progress, done: message };
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
      progress.push(message);
    }
  }

  it('dispatches to the owned page and returns flat JSON without a CLI', async () => {
    const browser = await reloadBrowser();
    await start();
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('desktop.reload.subscribe', { cwd: workspace, platform: 'web' })).toHaveProperty(
      'result.subscription',
    );
    const { progress, done } = await reloaded(client);
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const acceptsEvent = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
    expect([...progress, done].every((message) => acceptsEvent(message))).toBe(true);
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ platform: 'web', appId: browser.url, strategy: 'cdp' });
    expect(done.message).toContain('Completion is not observed');
    expect(browser.methods.filter((method) => method === 'Page.reload')).toEqual(['Page.reload']);
    expect(stimCalls()).toEqual([]);
    await until(() => readAudit().some((entry) => entry.action === 'reload' && entry.ok));
  });

  it('requires the private proof and refuses invalid selectors before dispatch', async () => {
    const browser = await reloadBrowser();
    const port = await start();
    const remote = await authed(port, true);
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    for (const client of [remote, plain])
      expect(await client.request('desktop.reload.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'forbidden',
      );
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, extra: true },
      { cwd: `${workspace}\0` },
      { cwd: workspace, platform: '' },
      { cwd: workspace, platform: '--help' },
      { cwd: workspace, platform: 'macos' },
      { cwd: join(root, 'missing') },
    ])
      expect(await client.request('desktop.reload.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    expect(browser.methods).toEqual([]);
  });

  it('reserves the actual workspace for stop, settings and phone actions when selected from a child directory', async () => {
    const browser = await reloadBrowser(workspace, true);
    const nested = join(workspace, 'src');
    mkdirSync(nested);
    const port = await start();
    const client = await desktop();
    const other = await desktop();
    const phone = await authed(port, true);
    await client.request('desktop.reload.subscribe', { cwd: nested, platform: 'web' });
    await browser.attaching;
    for (const [method, params] of [
      ['desktop.stop.subscribe', { cwd: workspace }],
      ['desktop.reload.subscribe', { cwd: workspace }],
      [
        'desktop.settings.write',
        { cwd: workspace, action: 'set', key: 'ios.runtime', value: '26.4', scope: 'workspace' },
      ],
    ] as const)
      expect(await other.request(method, params)).toHaveProperty('error.code', 'action-busy');
    expect(await phone.request('action', { action: 'reload', workspace })).toHaveProperty('error.code', 'action-busy');
    browser.release();
    expect((await reloaded(client)).done.exitCode).toBe(0);
    await until(() => readAudit().some((entry) => entry.ok && entry.action === 'reload'));
    expect(readAudit().find((entry) => entry.ok && entry.action === 'reload')?.workspace).toBe(workspace);
    expect(loadConfig()?.projects?.[workspace]?.ios).toBeUndefined();
  });

  it.each(['unsubscribe', 'disconnect'])('cancels on %s without sending a late reload', async (mode) => {
    const browser = await reloadBrowser(workspace, true);
    await start();
    const client = await desktop();
    const reply = await client.request('desktop.reload.subscribe', { cwd: workspace, platform: 'web' });
    const result: unknown = 'result' in reply ? reply.result : undefined;
    assert(isJsonObject(result) && typeof result.subscription === 'string');
    await browser.attaching;
    if (mode === 'unsubscribe') await client.request('unsubscribe', { subscription: result.subscription });
    else {
      client.socket.close();
      await client.closed;
    }
    await browser.closed;
    browser.release();
    await until(() => readAudit().some((entry) => entry.action === 'reload'));
    expect(readAudit().find((entry) => entry.action === 'reload')?.error?.message).toBe('STIM_CANCELLED');
    expect(browser.methods).not.toContain('Page.reload');
    expect(stimCalls()).toEqual([]);
  });

  it('aborts a timed-out attachment and records the deadline result after draining', async () => {
    const browser = await reloadBrowser(workspace, true);
    await start({ actionLimits: { timeoutMs: 500 } });
    const client = await desktop();
    await client.request('desktop.reload.subscribe', { cwd: workspace });
    await browser.attaching;
    expect((await reloaded(client)).done).toMatchObject({
      exitCode: 1,
      message: 'stim reload did not finish within 0.5 s.',
    });
    await browser.closed;
    await until(() => readAudit().some((entry) => entry.action === 'reload'));
    expect(readAudit().find((entry) => entry.action === 'reload')?.error?.message).toBe('STIM_RELOAD_TIMEOUT');
    expect(browser.methods).not.toContain('Page.reload');
  });

  it('returns typed refusals and bounds the terminal output', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}');
    await start();
    const client = await desktop();
    await client.request('desktop.reload.subscribe', { cwd: workspace, platform: 'ios' });
    const { done } = await reloaded(client);
    expect(done.exitCode).toBe(1);
    expect(JSON.parse(done.stdout)).toMatchObject({ code: 'STIM_RELOAD_STOPPED', remedy: 'Run `stim ios` first.' });
    assert(server);
    await server.close();
    forgetServer();
    const browser = await reloadBrowser();
    await start({ actionLimits: { maxOutputBytes: 1 } });
    const limited = await desktop();
    await limited.request('desktop.reload.subscribe', { cwd: workspace, platform: 'web' });
    expect((await reloaded(limited)).done).toMatchObject({
      exitCode: 1,
      stdout: '',
      message: 'stim reload printed more than 1 bytes.',
    });
    expect(browser.methods).toContain('Page.reload');
  });

  it('bounds concurrent reloads per connection and releases slots after cancellation', async () => {
    const roots = [workspace, ...Array.from({ length: 4 }, (_, i) => join(root, `app-${i}`))];
    for (const cwd of roots.slice(1)) mkdirSync(cwd);
    writeFileSync(
      join(root, 'home', 'config.json'),
      JSON.stringify({ projects: Object.fromEntries(roots.map((cwd) => [cwd, {}])) }),
    );
    const browsers = await Promise.all(roots.map((cwd, i) => reloadBrowser(cwd, i < 4)));
    await start({ requestLimits: { connection: 4 } });
    const client = await desktop();
    const subscriptions: string[] = [];
    for (const cwd of roots.slice(0, 4)) {
      const reply = await client.request('desktop.reload.subscribe', { cwd, platform: 'web' });
      const result: unknown = 'result' in reply ? reply.result : undefined;
      assert(isJsonObject(result) && typeof result.subscription === 'string');
      subscriptions.push(result.subscription);
    }
    await Promise.all(browsers.slice(0, 4).map((browser) => browser.attaching));
    expect(await client.request('desktop.reload.subscribe', { cwd: roots[4], platform: 'web' })).toHaveProperty(
      'error.code',
      'limit-exceeded',
    );
    for (const subscription of subscriptions) await client.request('unsubscribe', { subscription });
    await Promise.all(browsers.slice(0, 4).map((browser) => browser.closed));
    await until(() => readAudit().filter((entry) => entry.action === 'reload').length === 4);
    await client.request('desktop.reload.subscribe', { cwd: roots[4], platform: 'web' });
    expect((await reloaded(client)).done.exitCode).toBe(0);
    for (const browser of browsers.slice(0, 4)) expect(browser.methods).not.toContain('Page.reload');
  });
});

async function platformEnded(client: Client) {
  const progress: ServerMessage[] = [];
  for (;;) {
    const message = await client.next();
    if ('event' in message && (message.event === 'desktop-run-ended' || message.event === 'desktop-build-ended'))
      return { progress, done: message };
    if ('event' in message && message.event === 'error') throw new Error(message.error.message);
    progress.push(message);
  }
}

describe.skipIf(process.platform === 'win32')('Desktop web output', () => {
  it.each([
    { launched: true, running: true, verdict: 'loaded' },
    { launched: 'bundling', running: true, verdict: 'bundling' },
    { launched: 'unverified', running: true, verdict: 'unverified' },
    { launched: 'unverified', running: false, verdict: 'unverified' },
  ] as const)('preserves $verdict with running=$running', async ({ launched, running, verdict }) => {
    await start();
    const result: stim.StimRunResult = {
      platform: 'web',
      facts: {
        platform: 'web',
        browser: 'chrome',
        version: null,
        running,
        pid: running ? 123 : null,
        supervisorPid: null,
        url: 'http://localhost:8901/selected-page/',
        headless: true,
        viewport: 'desktop',
        profile: join(workspace, 'profile'),
        cdpEndpoint: null,
        targetId: null,
        reused: false,
        launched,
        metroPort: null,
        logs: { dir: join(workspace, 'logs') },
        durationMs: 1,
      },
    };
    const original = stimSelf.createStim;
    const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
      ...original(options),
      run: vi.fn<stim.StimClient['run']>().mockResolvedValue(result),
    }));
    try {
      const client = await desktop();
      await client.request('desktop.run.subscribe', { cwd: workspace, options: { platform: 'web' } });
      const observed = await platformEnded(client);
      expect(observed.done.exitCode).toBe(0);
      expect(JSON.parse(observed.done.stdout)).toEqual(result);
      expect(observed.done.message).toContain(`${result.facts.url} ${verdict}`);
      expect(observed.done.message).toContain('stim logs --errors');
      expect(observed.done.message.includes('stim web again')).toBe(!running);
      expect(stimCalls()).toEqual([]);
    } finally {
      api.mockRestore();
    }
  });
});

describe.skipIf(process.platform === 'win32')('Desktop platform build result', () => {
  it('orders build progress before artifact facts and preserves selectors without invoking a runtime', async () => {
    await start();
    const result: stim.StimBuildResult = {
      platform: 'android',
      facts: {
        apkPath: join(workspace, 'owned.apk'),
        androidPackage: 'dev.example.test',
        variant: 'demoDebug',
        abi: 'x86_64',
        cacheKey: 'exact-key',
        cacheHit: 'local',
        cacheSkipped: false,
        buildMachine: 'local',
        builtOn: null,
        ccache: { status: 'not-run', hits: null, misses: null, hitRatePercent: null },
        durationMs: 1,
        logs: { dir: join(workspace, 'logs') },
        links: { workspace: 'https://stim.appandflow.com/open' },
      },
    };
    const original = stimSelf.createStim;
    const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
      ...original(options),
      build: vi.fn<stim.StimClient['build']>().mockImplementation(async (request) => {
        expect(request).toMatchObject({
          platform: 'android',
          variant: 'demoDebug',
          abi: 'x86_64',
          buildCache: false,
          remoteBuild: 'local',
        });
        options.onProgress?.({ stream: 'stderr', message: 'Cache lookup\n' });
        options.onProgress?.({ stream: 'stdout', message: 'Artifact ready\n' });
        return result;
      }),
      run: async (): Promise<never> => {
        throw new Error('Build-only must never start a runtime.');
      },
    }));
    try {
      const client = await desktop();
      expect(
        await client.request('desktop.build.subscribe', {
          cwd: workspace,
          options: {
            platform: 'android',
            variant: 'demoDebug',
            abi: 'x86_64',
            buildCache: false,
            remoteBuild: 'local',
          },
        }),
      ).toHaveProperty('result.subscription');
      const observed = await platformEnded(client);
      expect(observed.progress).toMatchObject([
        { event: 'desktop-build-progress', stream: 'stderr', message: 'Cache lookup\n' },
        { event: 'desktop-build-progress', stream: 'stdout', message: 'Artifact ready\n' },
      ]);
      expect(observed.done).toMatchObject({ event: 'desktop-build-ended', exitCode: 0 });
      expect(JSON.parse(observed.done.stdout)).toEqual(result);
      expect(await client.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
      expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'build', platform: 'android', ok: true }));
      expect(stimCalls()).toEqual([]);
    } finally {
      api.mockRestore();
    }
  });
});

describe.skipIf(process.platform === 'win32').each(['run', 'build'] as const)('Desktop platform %s', (kind) => {
  it('requires private Desktop proof and validates platform selectors before effects', async () => {
    const port = await start();
    const peer = await pair(port, undefined, true);
    const remote = await connect(port, undefined, { keyPair: peer.keyPair });
    await remote.request('hello', { client: CLIENT });
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    for (const client of [plain, remote]) {
      expect(
        await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options: { platform: 'ios' } }),
      ).toHaveProperty('error.code', 'forbidden');
    }
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, options: {} },
      { cwd: workspace, options: { platform: 'other' } },
      { cwd: workspace, options: { platform: 'web', remote: 'mini' } },
      { cwd: workspace, options: { platform: 'ios', variant: 'debug' } },
      { cwd: workspace, options: { platform: 'android', simulatorApp: 'stim-desktop' } },
      { cwd: workspace, options: { platform: 'ios', device: 7 } },
      { cwd: workspace, options: { platform: 'ios', wait: {} } },
      { cwd: workspace, options: { platform: 'ios', slot: 'bad\0slot' } },
      { cwd: workspace, options: { platform: 'macos', remote: '' } },
      { cwd: workspace, options: { platform: 'web', headed: 'true' } },
      { cwd: workspace, options: { platform: 'ios', json: true } },
      { cwd: workspace, options: { platform: 'ios' }, signal: {} },
    ])
      expect(await client.request(`desktop.${kind}.subscribe`, params)).toHaveProperty('error.code', 'bad-request');
    const buildOnlyRefusals =
      kind === 'build'
        ? [
            { platform: 'ios', arch: 'aarch64' },
            { platform: 'android', abi: 'arm64' },
            { platform: 'macos', buildCache: false },
            { platform: 'ios', remote: 'mini' },
            { platform: 'ios', device: true },
            { platform: 'android', slot: 'fold' },
            { platform: 'ios', wait: '90' },
            { platform: 'android', metroCheck: false },
            { platform: 'ios', easProfile: 'development' },
            { platform: 'web' },
            { platform: 'ios', buildCache: 'false' },
            { platform: 'ios', scheme: '' },
            { platform: 'android', remoteBuild: 'x'.repeat(1025) },
          ]
        : [];
    for (const options of buildOnlyRefusals)
      expect(await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options })).toHaveProperty(
        'error.code',
        'bad-request',
      );
    expect(stimCalls()).toEqual([]);
  });

  it.each(
    kind === 'run'
      ? [{ platform: 'ios' }, { platform: 'macos', remote: 'eas' }]
      : [{ platform: 'ios' }, { platform: 'android' }],
  )('streams the real API refusal for %j without a CLI and releases the workspace', async (options) => {
    await start();
    const client = await desktop();
    expect(await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options })).toHaveProperty(
      'result.subscription',
    );
    const result = await platformEnded(client);
    expect(result.done.exitCode).toBe(1);
    expect(JSON.parse(result.done.stdout)).toMatchObject({
      code: options.platform === 'macos' ? 'STIM_BAD_ARG' : 'STIM_NO_PROJECT',
    });
    expect(readAudit()).toContainEqual(
      expect.objectContaining({ action: kind, platform: options.platform, ok: false }),
    );
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const accepts = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
    expect([...result.progress, result.done].every((message) => accepts(message))).toBe(true);
    expect(await client.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
    expect(stimCalls()).toEqual([]);
  });

  it('bounds real API output without sending an oversized progress event', async () => {
    await start({ actionLimits: { maxOutputBytes: 1 } });
    const client = await desktop();
    await client.request(`desktop.${kind}.subscribe`, { cwd: workspace, options: { platform: 'ios' } });
    const result = await platformEnded(client);
    expect(result.progress).toEqual([]);
    expect(result.done).toMatchObject({
      exitCode: 1,
      stdout: '',
      message: `${kind === 'run' ? 'stim ios' : 'ios build'} printed more than 1 bytes.`,
    });
    expect(stimCalls()).toEqual([]);
  });

  it.each(['unsubscribe', 'deadline', 'unknown-claims'] as const)(
    'drains cleanup before %s and retains unresolved admission',
    async (mode) => {
      const claim = tryAcquireClaim({ root: join(root, `draining-${kind}`), mode: 'exclusive' });
      assert(claim.acquired);
      const held = claim.acquired;
      await start({ actionLimits: { timeoutMs: mode === 'deadline' ? 100 : 5000 } });
      let cancelObserved = () => {};
      const cancelled = new Promise<void>((resolve) => {
        cancelObserved = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = stimSelf.createStim;
      const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
        ...original(options),
        [kind]: async (request: stim.StimRunOptions | stim.StimBuildOptions): Promise<never> => {
          const signal = request.signal;
          assert(signal);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          cancelObserved();
          await gate;
          throw new stim.StimError({
            code: 'STIM_CLAIM_UNAVAILABLE',
            message: `Fixture ${kind} cleanup is unresolved.`,
            remedy: `Recover ${held.path}`,
            details: mode === 'unknown-claims' ? undefined : { cause: { retainedClaimRoots: [held.root] } },
          });
        },
      }));
      try {
        const client = await desktop();
        const other = await desktop();
        const reply = await client.request(`desktop.${kind}.subscribe`, {
          cwd: workspace,
          options: { platform: 'ios' },
        });
        const result: unknown = 'result' in reply ? reply.result : undefined;
        assert(isJsonObject(result));
        let acknowledged = false;
        const response =
          mode === 'deadline'
            ? platformEnded(client)
            : client.request('unsubscribe', { subscription: result.subscription });
        void response.then(() => {
          acknowledged = true;
          return undefined;
        });
        await cancelled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(acknowledged).toBe(false);
        expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
          'error.code',
          'action-busy',
        );
        release();
        const answer = await response;
        const recoveryMessage = expect.stringContaining(`Recover ${held.path}`);
        expect('done' in answer ? JSON.parse(answer.done.stdout) : answer).toMatchObject(
          mode === 'deadline'
            ? { code: 'STIM_CLAIM_UNAVAILABLE', remedy: `Recover ${held.path}` }
            : { error: { code: 'action-failed', message: recoveryMessage } },
        );
        expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
          'error.code',
          'action-busy',
        );
        releaseClaim(held);
        const recovered = await other.request('desktop.stop.subscribe', { cwd: workspace });
        const subscription = expect.any(String);
        expect(recovered).toMatchObject(
          mode === 'unknown-claims' ? { error: { code: 'action-busy' } } : { result: { subscription } },
        );
      } finally {
        release();
        api.mockRestore();
        releaseClaim(held);
      }
    },
  );
});

describe.skipIf(process.platform === 'win32')('Desktop worktree warming', () => {
  async function ended(client: Client) {
    const progress: ServerMessage[] = [];
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-worktree-warm-ended') return { progress, done: message };
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
      progress.push(message);
    }
  }

  function warmingFixture() {
    const linked = join(root, 'warm-linked');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', timeout: 15_000 });
    git('init', '-q');
    writeFileSync(join(workspace, '.gitignore'), '.env\n');
    writeFileSync(join(workspace, 'package.json'), '{"dependencies":{"react-native":"0.88.0"}}');
    git('add', '.gitignore', 'package.json');
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial',
    );
    git('worktree', 'add', '--detach', linked);
    writeFileSync(join(workspace, '.env'), 'PRIVATE_FIXTURE=only');
    return linked;
  }

  it('copies real ignored state and streams its result without running the CLI', async () => {
    const linked = warmingFixture();
    await start({ env: { HOME: root, USERPROFILE: root, STIM_DAEMON: 'off' } });
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    expect(await client.request('desktop.worktree.warm.subscribe', { cwd: linked })).toHaveProperty(
      'result.subscription',
    );
    const { progress, done } = await ended(client);
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toEqual({ exitCode: 0 });
    expect(progress).toContainEqual(
      expect.objectContaining({ event: 'desktop-worktree-warm-progress', stream: 'stderr' }),
    );
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    validator.addSchema(protocolJsonSchema(), 'protocol');
    const accepts = validator.compile({ $ref: 'protocol#/$defs/ServerEvent' });
    expect([...progress, done].every((message) => accepts(message))).toBe(true);
    expect(readFileSync(join(linked, '.env'), 'utf8')).toBe('PRIVATE_FIXTURE=only');
    expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'worktree-warm', ok: true }));
    expect(stimCalls()).toEqual([]);
  });

  it.each(['plain local', 'phone control'])('denies warming from %s', async (mode) => {
    const port = await start();
    assert(server);
    const client =
      mode === 'phone control'
        ? await connect(port, undefined, { keyPair: (await pair(port, undefined, true)).keyPair })
        : await localConnect(server);
    await client.request('hello', { client: CLIENT });
    expect(await client.request('desktop.worktree.warm.subscribe', { cwd: workspace })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(stimCalls()).toEqual([]);
  });

  it('rejects malformed warm requests before effects', async () => {
    await start();
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, refresh: true },
      { cwd: workspace, target: workspace },
      { cwd: workspace, signal: {} },
    ])
      expect(await client.request('desktop.worktree.warm.subscribe', params)).toHaveProperty(
        'error.code',
        'bad-request',
      );
    expect(stimCalls()).toEqual([]);
  });

  it.each([false, true])(
    'allows long warming unless an explicit server deadline applies: %s',
    async (shortDeadline) => {
      await start(shortDeadline ? { actionLimits: { timeoutMs: 100 } } : {});
      const client = await desktop();
      let began = () => {};
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signal: AbortSignal | undefined;
      const original = stimSelf.createStim;
      const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
        ...original(options),
        warmWorktree: async (request: stim.StimWorktreeWarmOptions = {}) => {
          signal = request.signal;
          began();
          await gate;
          return { exitCode: 0 };
        },
      }));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        expect(await client.request('desktop.worktree.warm.subscribe', { cwd: workspace })).toHaveProperty(
          'result.subscription',
        );
        await started;
        await vi.advanceTimersByTimeAsync(180_000);
        expect(signal?.aborted).toBe(shortDeadline);
        release();
        const { done } = await ended(client);
        expect(done.exitCode).toBe(shortDeadline ? 1 : 0);
        expect(done.message).toBe(
          shortDeadline ? 'stim worktree warm did not finish within 0.1 s.' : 'Worktree warming completed.',
        );
      } finally {
        release();
        vi.useRealTimers();
        api.mockRestore();
      }
    },
  );

  it('bounds warming progress before sending an oversized event', async () => {
    const linked = warmingFixture();
    await start({ actionLimits: { maxOutputBytes: 1 }, env: { HOME: root, USERPROFILE: root } });
    const client = await desktop();
    expect(await client.request('desktop.worktree.warm.subscribe', { cwd: linked })).toHaveProperty(
      'result.subscription',
    );
    const result = await ended(client);
    expect(result.progress).toEqual([]);
    expect(result.done).toMatchObject({
      exitCode: 1,
      stdout: '',
      message: 'stim worktree warm printed more than 1 bytes.',
    });
    expect(stimCalls()).toEqual([]);
  });

  it('reserves resolved descendant workspaces while queued and releases them after cancellation', async () => {
    const linked = warmingFixture();
    const nested = join(linked, 'nested');
    mkdirSync(nested);
    const home = process.env.STIM_HOME;
    assert(home);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 2, projects: { [nested]: { metroPort: null } } }),
    );
    let admitted = () => {};
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const original = stimSelf.createStim;
    const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => {
      const client = original(options);
      return {
        ...client,
        warmWorktree: (request: stim.StimWorktreeWarmOptions = {}) =>
          client.warmWorktree({
            ...request,
            beforeWarm: (path) => {
              request.beforeWarm?.(path);
              if (path === nested) admitted();
            },
          }),
      };
    });
    await start({ env: { HOME: root, USERPROFILE: root, STIM_DAEMON: 'off' } });
    const claim = tryAcquireClaim({
      root: join(home, 'warm-locks', `${workspaceName(workspace)}.lock`),
      mode: 'exclusive',
    });
    assert(claim.acquired);
    try {
      const client = await desktop();
      const other = await desktop();
      const reply = await client.request('desktop.worktree.warm.subscribe', { cwd: linked });
      const result: unknown = 'result' in reply ? reply.result : undefined;
      assert(isJsonObject(result));
      await ready;
      expect(await other.request('desktop.stop.subscribe', { cwd: nested })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      expect(await client.request('unsubscribe', { subscription: result.subscription })).toHaveProperty('result');
      expect(existsSync(join(linked, '.env'))).toBe(false);
      const stopping = await other.request('desktop.stop.subscribe', { cwd: nested });
      expect(stopping).toHaveProperty('result.subscription');
      const stopped: unknown = 'result' in stopping ? stopping.result : undefined;
      assert(isJsonObject(stopped));
      await other.request('unsubscribe', { subscription: stopped.subscription });
      expect(stimCalls()).toEqual([]);
    } finally {
      releaseClaim(claim.acquired);
      api.mockRestore();
    }
  });

  it('waits for cancelled warming cleanup and retains admission until exact claims are released', async () => {
    const claim = tryAcquireClaim({ root: join(root, 'warm-draining'), mode: 'exclusive' });
    assert(claim.acquired);
    const held = claim.acquired;
    let cancelled = () => {};
    const observed = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = stimSelf.createStim;
    const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
      ...original(options),
      warmWorktree: async (request: stim.StimWorktreeWarmOptions = {}) => {
        const signal = request.signal;
        assert(signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelled();
        await gate;
        throw new stim.StimError({
          code: 'STIM_CLAIM_UNAVAILABLE',
          message: `Recover ${held.path}`,
          details: { cause: { retainedClaimRoots: [held.root] } },
        });
      },
    }));
    try {
      await start();
      const client = await desktop();
      const other = await desktop();
      const reply = await client.request('desktop.worktree.warm.subscribe', { cwd: workspace });
      const result: unknown = 'result' in reply ? reply.result : undefined;
      assert(isJsonObject(result));
      let acknowledged = false;
      const response = client.request('unsubscribe', { subscription: result.subscription });
      void response.then(() => {
        acknowledged = true;
        return undefined;
      });
      await observed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acknowledged).toBe(false);
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      release();
      expect(await response).toMatchObject({
        error: { code: 'action-failed', message: expect.stringContaining(held.path) },
      });
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      releaseClaim(held);
      expect(await other.request('desktop.stop.subscribe', { cwd: workspace })).toHaveProperty('result.subscription');
    } finally {
      release();
      releaseClaim(held);
      api.mockRestore();
    }
  });
});

describe.skipIf(process.platform === 'win32')('Desktop worktree removal', () => {
  function removalFixture() {
    const linked = join(root, 'linked');
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', workspace, ...args], { env, encoding: 'utf8', timeout: 15_000 }).trim();
    git('init', '-q');
    writeFileSync(join(workspace, 'package.json'), '{"private":true}');
    git('add', 'package.json');
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial',
    );
    git('worktree', 'add', '-b', 'rpc-owned', linked);
    assert(process.env.STIM_HOME);
    writeFileSync(
      join(process.env.STIM_HOME, 'config.json'),
      JSON.stringify({
        version: 2,
        projects: {
          [workspace]: { metroPort: null },
          [linked]: {
            metroPort: null,
            worktreeBranchOwned: true,
            worktreeBranch: 'rpc-owned',
            worktreeMainRoot: workspace,
          },
        },
      }),
    );
    return { linked, git, env: { HOME: root, USERPROFILE: root, STIM_DAEMON: 'off' } };
  }

  async function remove(client: Client, params: unknown) {
    expect(await client.request('desktop.worktree.remove.subscribe', params)).toHaveProperty('result.subscription');
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-worktree-remove-ended') return message;
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
    }
  }

  it('transports dirty refusal, forced deletion and source cleanup without running the CLI', async () => {
    const fixture = removalFixture();
    const unsaved = join(fixture.linked, 'unsaved.txt');
    writeFileSync(unsaved, 'keep until explicitly forced');
    await start({ env: fixture.env });
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    const refused = await remove(client, { cwd: workspace, target: fixture.linked });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toEqual({ removed: false, exitCode: 1 });
    expect(existsSync(unsaved)).toBe(true);
    const removed = await remove(client, { cwd: workspace, target: fixture.linked, force: true });
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: true, exitCode: 0 });
    expect(existsSync(fixture.linked)).toBe(false);
    const source = await remove(client, { cwd: workspace });
    expect(JSON.parse(source.stdout)).toEqual({ removed: false, exitCode: 0 });
    expect(existsSync(join(workspace, '.git'))).toBe(true);
    expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'worktree-remove', ok: true }));
    expect(stimCalls()).toEqual([]);
  });

  it.each(['alias', 'subfolder', 'descendant'])(
    'reserves the resolved %s scope through drain and refuses a busy target',
    async (mode) => {
      const fixture = removalFixture();
      const alias = join(root, 'linked-alias');
      symlinkSync(fixture.linked, alias);
      const nested = join(fixture.linked, 'app');
      mkdirSync(nested);
      const busy = mode === 'descendant' ? nested : fixture.linked;
      if (mode === 'descendant') {
        const configFile = join(root, 'home', 'config.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8'));
        config.projects[nested] = { metroPort: null };
        writeFileSync(configFile, JSON.stringify(config));
      }
      const target = mode === 'subfolder' ? nested : alias;
      let observed = () => {};
      const admitted = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const original = stimSelf.createStim;
      const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => {
        const client = original(options);
        return {
          ...client,
          removeWorktree: (request: stim.StimWorktreeRemoveOptions = {}) =>
            client.removeWorktree({
              ...request,
              beforeRemove: (path) => {
                request.beforeRemove?.(path);
                if (path === busy) observed();
              },
            }),
        };
      });
      await start({ env: fixture.env });
      const client = await desktop();
      const other = await desktop();
      const lock = tryAcquireClaim({
        root: join(root, 'home', 'config.lock.claims'),
        mode: 'exclusive',
        label: 'fixture metadata',
      });
      assert(lock.acquired);
      try {
        const removing = await client.request('desktop.worktree.remove.subscribe', { cwd: workspace, target });
        const removal: unknown = 'result' in removing ? removing.result : undefined;
        assert(isJsonObject(removal));
        await admitted;
        for (const method of ['desktop.stop.subscribe', 'desktop.reload.subscribe'])
          expect(await other.request(method, { cwd: busy })).toHaveProperty('error.code', 'action-busy');
        await client.request('unsubscribe', { subscription: removal.subscription });
        expect(existsSync(fixture.linked)).toBe(true);
        const stopping = await other.request('desktop.stop.subscribe', { cwd: busy });
        const stop: unknown = 'result' in stopping ? stopping.result : undefined;
        assert(isJsonObject(stop));
        const refused = await remove(client, { cwd: workspace, target });
        expect(refused.exitCode).toBe(1);
        expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'STIM_ACTION_BUSY' });
        expect(existsSync(fixture.linked)).toBe(true);
        await other.request('unsubscribe', { subscription: stop.subscription });
        expect(stimCalls()).toEqual([]);
      } finally {
        releaseClaim(lock.acquired);
        api.mockRestore();
      }
    },
    30_000,
  );

  it('retains deletion success when branch cleanup fails and accepts a missing target for retry', async () => {
    const fixture = removalFixture();
    const lock = join(workspace, '.git', 'refs', 'heads', 'rpc-owned.lock');
    writeFileSync(lock, 'held');
    await start({ env: fixture.env });
    const client = await desktop();
    const partial = await remove(client, { cwd: workspace, target: fixture.linked });
    expect(partial.exitCode).toBe(1);
    expect(JSON.parse(partial.stdout)).toEqual({ removed: true, exitCode: 1 });
    expect(existsSync(fixture.linked)).toBe(false);
    rmSync(lock);
    const retried = await remove(client, { cwd: workspace, target: fixture.linked });
    expect(retried.exitCode).toBe(0);
    expect(JSON.parse(retried.stdout)).toEqual({ removed: false, exitCode: 0 });
    expect(fixture.git('branch', '--list', 'rpc-owned')).toBe('');
    expect(stimCalls()).toEqual([]);
  });

  it.each(['plain local', 'phone control'])('denies removal from %s without deleting the target', async (mode) => {
    const fixture = removalFixture();
    const port = await start({ env: fixture.env });
    assert(server);
    const client =
      mode === 'phone control'
        ? await connect(port, undefined, { keyPair: (await pair(port, undefined, true)).keyPair })
        : await localConnect(server);
    await client.request('hello', { client: CLIENT });
    expect(
      await client.request('desktop.worktree.remove.subscribe', { cwd: workspace, target: fixture.linked }),
    ).toHaveProperty('error.code', 'forbidden');
    expect(existsSync(fixture.linked)).toBe(true);
    expect(stimCalls()).toEqual([]);
  });

  it('rejects malformed effects before removing a worktree', async () => {
    const fixture = removalFixture();
    await start({ env: fixture.env });
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, target: '' },
      { cwd: workspace, target: '../linked' },
      { cwd: workspace, target: 1 },
      { cwd: workspace, target: fixture.linked, force: 'yes' },
      { cwd: workspace, target: fixture.linked, delete: true },
    ])
      expect(await client.request('desktop.worktree.remove.subscribe', params)).toHaveProperty(
        'error.code',
        'bad-request',
      );
    expect(existsSync(fixture.linked)).toBe(true);
    expect(stimCalls()).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('Desktop GC mutation', () => {
  function cacheFixture() {
    const home = process.env.STIM_HOME;
    assert(home);
    const cache = join(home, 'rpc-cache');
    mkdirSync(cache);
    const artifact = join(cache, 'artifact');
    writeFileSync(artifact, 'keep until requested cleanup');
    writeFileSync(
      join(home, 'caches.json'),
      JSON.stringify({
        version: 1,
        caches: [{ name: 'rpc-fixture', dir: cache, prune: 'entries' }],
      }),
    );
    return { home, cache, artifact, env: { HOME: root, USERPROFILE: root, STIM_DAEMON: 'off' } };
  }

  async function ended(client: Client) {
    for (;;) {
      const message = await client.next();
      if ('event' in message && message.event === 'desktop-gc-ended') return message;
      if ('event' in message && message.event === 'error') throw new Error(message.error.message);
    }
  }

  it('deletes only the selected private cache and refreshes cached reports without a CLI process', async () => {
    const fixture = cacheFixture();
    await start({ env: fixture.env });
    const client = await desktop();
    const before = await client.request('desktop.reports.get', { report: 'gc' });
    expect(before).toMatchObject({
      result: {
        value: {
          sections: {
            caches: expect.arrayContaining([expect.objectContaining({ name: 'rpc-fixture', dir: fixture.cache })]),
          },
        },
      },
    });
    const config = readFileSync(join(fixture.home, 'config.json'), 'utf8');
    expect(
      await client.request('desktop.gc.item.subscribe', {
        cwd: workspace,
        item: { kind: 'cache', dir: fixture.cache },
      }),
    ).toHaveProperty('result.subscription');
    const done = await ended(client);
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({
      results: [expect.objectContaining({ kind: 'cache', status: 'done' })],
    });
    expect(existsSync(fixture.artifact)).toBe(false);
    expect(readFileSync(join(fixture.home, 'config.json'), 'utf8')).toBe(config);
    expect(await client.request('desktop.reports.get', { report: 'gc' })).not.toEqual(before);
    expect(readClaimSet(join(fixture.home, 'maintenance', 'run.claims'))).toMatchObject({ live: [], unresolved: [] });
    expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'gc', ok: true }));
    expect(stimCalls()).toEqual([]);
  });

  it('denies unproved local and phone control and rejects invalid selectors before deleting files', async () => {
    const fixture = cacheFixture();
    const port = await start({ env: fixture.env });
    const paired = await pair(port, undefined, true);
    const peer = await connect(port, undefined, { keyPair: paired.keyPair });
    assert(server);
    const plain = await localConnect(server);
    await plain.request('hello', { client: CLIENT });
    await peer.request('hello', { client: CLIENT });
    for (const client of [plain, peer]) {
      expect(await client.request('desktop.gc.subscribe', { cwd: workspace, dryRun: false })).toHaveProperty(
        'error.code',
        'forbidden',
      );
      expect(
        await client.request('desktop.gc.item.subscribe', {
          cwd: workspace,
          item: { kind: 'cache', dir: fixture.cache },
        }),
      ).toHaveProperty('error.code', 'forbidden');
    }
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.', dryRun: true },
      { cwd: workspace },
      { cwd: workspace, dryRun: 'yes' },
      { cwd: workspace, dryRun: false, pressure: 'max' },
      { cwd: workspace, dryRun: false, cache: 'rpc-fixture' },
      { cwd: workspace, dryRun: false, delete: true },
      { cwd: workspace, dryRun: false, olderThan: 1 },
    ])
      expect(await client.request('desktop.gc.subscribe', params)).toHaveProperty('error.code', 'bad-request');
    for (const item of [
      undefined,
      { kind: 'cache', dir: 'relative' },
      { kind: 'cache', dir: fixture.cache, extra: 1 },
      { kind: 'archive', id: '../x' },
      { kind: 'archive', id: 'a', part: 'everything' },
      { kind: 'parked' },
    ])
      expect(
        await client.request('desktop.gc.item.subscribe', {
          cwd: workspace,
          item,
        }),
      ).toHaveProperty('error.code', 'bad-request');
    expect(readFileSync(fixture.artifact, 'utf8')).toBe('keep until requested cleanup');
    expect(stimCalls()).toEqual([]);
  });

  it.each(['unsubscribe', 'disconnect', 'shutdown', 'timeout'] as const)(
    '%s drains the actual GC native child and preserves files before releasing admission',
    async (ending) => {
      const fixture = cacheFixture();
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const witness = join(root, 'gc-child');
      const du = join(bin, 'du');
      writeFileSync(
        du,
        `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(witness)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      chmodSync(du, 0o755);
      let record: { pid: number; processToken: string } | undefined;
      try {
        await start({
          env: { ...fixture.env, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) },
          ...(ending === 'timeout' ? { actionLimits: { timeoutMs: 1500 } } : {}),
        });
        const client = await desktop();
        const reply = await client.request('desktop.gc.item.subscribe', {
          cwd: workspace,
          item: { kind: 'cache', dir: fixture.cache },
        });
        assert(
          'result' in reply &&
            isJsonObject(reply.result) &&
            'subscription' in reply.result &&
            typeof reply.result.subscription === 'string',
        );
        await until(() => existsSync(witness));
        const pid = await readPid(witness);
        const processToken = captureProcessToken(pid);
        assert(processToken);
        record = { pid, processToken };
        const claims = join(fixture.home, 'maintenance', 'run.claims');
        expect(readClaimSet(claims).live).toContainEqual(
          expect.objectContaining({ child: expect.objectContaining({ pid }) }),
        );
        const other = await desktop();
        expect(await other.request('desktop.settings.get', { cwd: workspace })).toHaveProperty('result');
        let completion: unknown = {};
        if (ending === 'unsubscribe')
          completion = await client.request('unsubscribe', { subscription: reply.result.subscription });
        else if (ending === 'disconnect') client.socket.close();
        else if (ending === 'shutdown') {
          assert(server);
          await server.close();
          forgetServer();
        } else completion = await ended(client);
        const unsubscribed = { result: expect.any(Object) };
        const timedOut = { exitCode: 1, message: expect.stringContaining('did not finish') };
        expect(completion).toMatchObject(
          ending === 'unsubscribe' ? unsubscribed : ending === 'timeout' ? timedOut : {},
        );
        await until(() => inspectProcessIdentity(record) !== 'same');
        expect(inspectProcessIdentity(record)).toMatch(/^(gone|different)$/);
        await until(() => readClaimSet(claims).live.length === 0);
        expect(readClaimSet(claims).unresolved).toEqual([]);
        expect(readFileSync(fixture.artifact, 'utf8')).toBe('keep until requested cleanup');
        expect(stimCalls()).toEqual([]);
      } finally {
        if (record && inspectProcessIdentity(record) === 'same') process.kill(record.pid, 'SIGKILL');
        await server?.close();
        forgetServer();
      }
    },
  );

  it('keeps a failed cache deletion in the JSON report and returns a failing exit status', async () => {
    const fixture = cacheFixture();
    writeFileSync(
      join(fixture.home, 'caches.json'),
      JSON.stringify({
        version: 1,
        caches: [{ name: 'rpc-fixture', dir: fixture.cache, prune: 'atomic' }],
      }),
    );
    const original = fsPromises.rm;
    const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (path === fixture.artifact) throw new Error('fixture deletion denied');
      return original(path, options);
    });
    syncBuiltinESMExports();
    try {
      await start({ env: fixture.env });
      const client = await desktop();
      expect(
        await client.request('desktop.gc.item.subscribe', {
          cwd: workspace,
          item: { kind: 'cache', dir: fixture.cache },
        }),
      ).toHaveProperty('result.subscription');
      const done = await ended(client);
      expect(done.exitCode).toBe(1);
      expect(JSON.parse(done.stdout)).toMatchObject({
        mode: 'delete',
        item: { kind: 'cache', dir: fixture.cache },
        failures: 1,
        results: expect.arrayContaining([
          expect.objectContaining({ kind: 'cache', status: 'failed', id: fixture.cache }),
        ]),
      });
      expect(existsSync(fixture.artifact)).toBe(true);
      expect(readAudit()).toContainEqual(expect.objectContaining({ action: 'gc', ok: false }));
      expect(readClaimSet(join(fixture.home, 'maintenance', 'run.claims'))).toMatchObject({ live: [], unresolved: [] });
    } finally {
      deletion.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('bounds GC progress and terminal JSON while retaining files on a read-only request', async () => {
    const fixture = cacheFixture();
    await start({ env: fixture.env, actionLimits: { maxOutputBytes: 128 } });
    const client = await desktop();
    expect(await client.request('desktop.gc.subscribe', { cwd: workspace, dryRun: true })).toHaveProperty(
      'result.subscription',
    );
    expect(await ended(client)).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('printed more than 128 bytes'),
    });
    expect(existsSync(fixture.artifact)).toBe(true);
    expect(readClaimSet(join(fixture.home, 'maintenance', 'run.claims'))).toMatchObject({ live: [], unresolved: [] });
  });
});

describe.skipIf(process.platform === 'win32')('Desktop machine access requests', () => {
  it('returns an in-process setup report without exposing its ticket or running the CLI', async () => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    await start({ env: { HOME: root, USERPROFILE: root, STIM_DAEMON: 'off' } });
    const client = await desktop();
    rmSync(join(root, 'fake-stim.mjs'));
    const ticket = 'a'.repeat(42) + 'A';
    expect(await client.request('desktop.machine-access.subscribe', { cwd: workspace, ticket })).toHaveProperty(
      'result.subscription',
    );
    let terminal: ServerMessage;
    for (;;) {
      terminal = await client.next();
      if ('event' in terminal && terminal.event === 'desktop-machine-access-ended') break;
    }
    assert('event' in terminal && terminal.event === 'desktop-machine-access-ended');
    expect(terminal).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(terminal.stdout)).toMatchObject({ project: workspace, platform: 'ios' });
    expect(JSON.stringify(terminal)).not.toContain(ticket);
    expect(JSON.stringify(readAudit())).not.toContain(ticket);
    expect(stimCalls()).toEqual([]);
  });

  it.each(['plain local', 'phone control'])('denies access requests from %s', async (mode) => {
    const port = await start();
    assert(server);
    const client =
      mode === 'phone control'
        ? await connect(port, undefined, { keyPair: (await pair(port, undefined, true)).keyPair })
        : await localConnect(server);
    await client.request('hello', { client: CLIENT });
    expect(await client.request('desktop.machine-access.subscribe', { cwd: workspace })).toHaveProperty(
      'error.code',
      'forbidden',
    );
    expect(stimCalls()).toEqual([]);
  });

  it('rejects invalid tickets and extra environment before effects without echoing secrets', async () => {
    await start();
    const client = await desktop();
    for (const params of [
      {},
      { cwd: '.' },
      { cwd: workspace, fix: true },
      { cwd: workspace, ticket: 'private-invalid-ticket' },
      { cwd: workspace, ticket: 'B'.repeat(43) },
      { cwd: workspace, extraEnvironment: { STIM_ACCESS_TICKET: 'private-invalid-ticket' } },
    ]) {
      const reply = await client.request('desktop.machine-access.subscribe', params);
      expect(reply).toHaveProperty('error.code', 'bad-request');
      expect(JSON.stringify(reply)).not.toContain('private-invalid-ticket');
    }
    expect(existsSync(join(root, 'home', 'build-machines.json'))).toBe(false);
    expect(existsSync(join(root, 'home', 'device-host-machines.json'))).toBe(false);
    expect(stimCalls()).toEqual([]);
  });

  it('acknowledges cancellation only after access cleanup and retains unresolved admission', async () => {
    let cancelled = () => {};
    const observed = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = stimSelf.createStim;
    const api = vi.spyOn(stimSelf, 'createStim').mockImplementation((options) => ({
      ...original(options),
      requestMachineAccess: async ({ signal }: stim.StimMachineAccessOptions = {}) => {
        assert(signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelled();
        await gate;
        throw new stim.StimError({ code: 'STIM_CLAIM_UNAVAILABLE', message: 'Access request cleanup is unresolved.' });
      },
    }));
    try {
      await start();
      const client = await desktop();
      const other = await desktop();
      const reply = await client.request('desktop.machine-access.subscribe', { cwd: workspace });
      assert('result' in reply && isJsonObject(reply.result) && 'subscription' in reply.result);
      let acknowledged = false;
      const response = client.request('unsubscribe', { subscription: reply.result.subscription });
      void response.then(() => {
        acknowledged = true;
        return undefined;
      });
      await observed;
      expect(acknowledged).toBe(false);
      expect(await other.request('desktop.machine-access.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
      release();
      expect(await response).toMatchObject({
        error: { code: 'action-failed', message: 'STIM_CLAIM_UNAVAILABLE: Access request cleanup is unresolved.' },
      });
      expect(await other.request('desktop.machine-access.subscribe', { cwd: workspace })).toHaveProperty(
        'error.code',
        'action-busy',
      );
    } finally {
      release();
      api.mockRestore();
    }
  });
});
