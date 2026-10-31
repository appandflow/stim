import assert from 'node:assert';
import type { SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type NdjsonWriter, parseNdjsonText } from '../ndjson.ts';
import { expoSdkMajor, inferLevel, recordFromLine, startExpoServer } from '../supervisor/server-expo.ts';
import {
  expoMetroConfigPath,
  expoMetroStoreEnv,
  metroStoreConfirmedRoot,
  metroStoreRoot,
} from '../supervisor/metro-store.ts';
import { trackDevServerActivity } from '../supervisor/idle-stop.ts';
import { IMPOSSIBLE_PID, makeChildProcess } from './_factories.ts';

type ExpoExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

let root: string;
let tmpHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-expo-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.NODE_OPTIONS;
  delete process.env.EXPO_OVERRIDE_METRO_CONFIG;
});

function fakeBin(dir = root, sdk = 54) {
  const bin = join(dir, 'node_modules', '.bin', 'expo');
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  const expo = join(dir, 'node_modules', 'expo');
  mkdirSync(expo, { recursive: true });
  writeFileSync(join(expo, 'package.json'), JSON.stringify({ name: 'expo', version: `${sdk}.0.0` }));
  return bin;
}

function fakeChild(pid = IMPOSSIBLE_PID) {
  return makeChildProcess({ pid });
}

async function withoutProcessKill(fn: (byPid: Array<[number, string | number]>) => Promise<void>): Promise<void> {
  const byPid: Array<[number, string | number]> = [];
  const realKill = process.kill;
  process.kill = ((pid: number, sig: string | number) => {
    byPid.push([pid, sig]);
    return true;
  }) as typeof process.kill;
  try {
    await fn(byPid);
  } finally {
    process.kill = realKill;
  }
}

describe('line parsing', () => {
  test('inferLevel treats a Node-exception line (PluginError:, CommandError:) as an error (#30)', () => {
    expect(inferLevel('PluginError: Failed to resolve plugin for module "expo-share-intent"')).toBe('error');
    expect(inferLevel('CommandError: something broke')).toBe('error');
    expect(inferLevel('Errors were found')).toBe('info');
    expect(inferLevel('PluginErrorish text without colon')).toBe('info');
  });

  test('inferLevel reads the symbols Expo uses instead of words', () => {
    expect(inferLevel('\u2716 Metro encountered an error')).toBe('error');
    expect(inferLevel('\u274C build failed')).toBe('error');
    expect(inferLevel('\u26A0 something is off')).toBe('warn');
  });
});

describe('startExpoServer', () => {
  test('bundle responses that start and finish within a second are all logged and leave the idle tracker with no open request', async () => {
    fakeBin();
    const child = fakeChild();
    let clock = 1_000_000;
    const activity = trackDevServerActivity(() => clock);
    const written: Record<string, unknown>[] = [];
    const writer = {
      file: join(root, 'metro.ndjson'),
      write(record: unknown) {
        activity.record(record);
        written.push(record as Record<string, unknown>);
        return true;
      },
    } as unknown as NdjsonWriter;
    await startExpoServer({ root, port: 8115, logsDir: join(root, 'logs'), writer, spawnFn: () => child });
    const line = (stage: 'started' | 'finished', requestId: string) =>
      `stim-bundle-response: ${JSON.stringify({
        ts: clock,
        src: 'metro',
        level: 'debug',
        event: `bundle_response_${stage}`,
        platform: 'ios',
        requestId,
        msg: `ios bundle response ${stage}`,
      })}\n`;
    child.stderr!.emit('data', line('started', 'a'));
    child.stdout!.emit('data', 'iOS Bundling index.js\n');
    child.stderr!.emit('data', line('started', 'b'));
    child.stderr!.emit('data', line('started', 'c'));
    for (const id of ['a', 'b', 'c']) child.stderr!.emit('data', line('finished', id));

    const bundle = written.filter((r) => String(r.event).startsWith('bundle_response_'));
    expect(bundle.map((r) => `${r.event}:${r.requestId}`)).toEqual([
      'bundle_response_started:a',
      'bundle_response_started:b',
      'bundle_response_started:c',
      'bundle_response_finished:a',
      'bundle_response_finished:b',
      'bundle_response_finished:c',
    ]);
    const quietSince = clock;
    clock += 3_600_000;
    expect(activity.lastActivityAt()).toBe(quietSince);
  });

  test('the child inherits the supervisor process environment (#33)', async () => {
    fakeBin();
    process.env.STIM_TEST_SENTINEL = 'through';
    const calls: { opts: SpawnOptions }[] = [];
    try {
      await startExpoServer({
        root,
        port: 8113,
        logsDir: join(root, 'logs'),
        spawnFn: (_cmd, _args, opts) => {
          calls.push({ opts });
          return fakeChild();
        },
      });
    } finally {
      delete process.env.STIM_TEST_SENTINEL;
    }
    const env = calls[0]?.opts.env as Record<string, string>;
    expect(env.STIM_TEST_SENTINEL).toBe('through');
    expect(env.FORCE_COLOR).toBe('0');
  });

  test('a spawn that never starts (ENOENT) reports an exit rather than hanging', async () => {
    fakeBin();
    const child = fakeChild();
    const handle = await startExpoServer({ root, port: 8114, logsDir: join(root, 'logs'), spawnFn: () => child });
    const exits: (ExpoExitInfo | null)[] = [];
    handle.onExit((info) => exits.push(info));
    child.emit('error', new Error('spawn EACCES'));
    expect(exits.length).toBe(1);
    const first = exits[0];
    assert(first);
    assert(first.error);
    expect(first.error.message).toMatch(/EACCES/);
  });

  test('a child that ignores SIGTERM is escalated to SIGKILL rather than left holding the port', async () => {
    fakeBin();
    const child = fakeChild();
    const signals: Array<string | number> = [];
    child.kill = ((sig: string | number) => {
      signals.push(sig);
      if (sig === 'SIGKILL') child.emit('exit', null, 'SIGKILL');
      return true;
    }) as typeof child.kill;
    const handle = await startExpoServer({
      root,
      port: 8117,
      logsDir: join(root, 'logs'),
      spawnFn: () => child,
      killTimeoutMs: 20,
    });
    await withoutProcessKill(async (byPid) => {
      await handle.close();
      expect(byPid).toEqual([]);
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

test('inferLevel classifies Expo bundling failures as errors', () => {
  expect(inferLevel('iOS Bundling failed 6566ms apps/tlon-mobile/index.tsx (1 module)')).toBe('error');
  expect(inferLevel('Unable to resolve "./tailwind.json" from "index.tsx"')).toBe('error');
  expect(inferLevel('Failed to load app from http://localhost:8084')).toBe('error');
  expect(inferLevel('iOS Bundled 812ms index.js (1150 modules)')).toBe('info');
  expect(inferLevel('Bundling 100%')).toBe('info');
});

describe('starting a tunnel', () => {
  test('the printed tunnel URL is reported exactly once, through onTunnelUrl', async () => {
    fakeBin();
    const child = fakeChild();
    const urls: string[] = [];
    await startExpoServer({
      root,
      port: 8122,
      logsDir: join(root, 'logs'),
      tunnel: true,
      spawnFn: () => child,
      onTunnelUrl: (url) => urls.push(url),
    });
    child.stdout!.emit('data', 'Waiting on exp://abc123.exp.direct\n');
    child.stdout!.emit('data', 'Waiting on exp://abc123.exp.direct\n');
    expect(urls).toEqual(['https://abc123.exp.direct']);
  });
});
describe('the Metro store injected into an Expo child', () => {
  const adapter = '/pkg/Stim/shim/expo-metro-config.cjs';

  test('the env additions point Expo at the adapter and preserve an existing override', () => {
    expect(
      expoMetroStoreEnv({
        root: '/w/app',
        port: 8082,
        storeRoot: '/cache/app',
        adapterPath: adapter,
        existingOverride: '/w/app/custom-metro.cjs',
      }),
    ).toEqual({
      EXPO_OVERRIDE_METRO_CONFIG: adapter,
      STIM_METRO_STORE: '/cache/app',
      STIM_PROJECT_ROOT: '/w/app',
      STIM_METRO_PORT: '8082',
      STIM_EXPO_METRO_CONFIG: '/w/app/custom-metro.cjs',
    });
  });

  test('the adapter ships in this package and is found from here', () => {
    const found = expoMetroConfigPath();
    assert(found);
    expect(found.endsWith(join('shim', 'expo-metro-config.cjs'))).toBe(true);
    expect(existsSync(found)).toBe(true);
    expect(expoMetroConfigPath(pathToFileURL(resolve('/nowhere/at/all/x.js')).href)).toBe(null);
  });

  test('the spawned SDK 54 child carries the adapter, store, and caller environment', async () => {
    fakeBin();
    process.env.NODE_OPTIONS = '--max-old-space-size=8192';
    process.env.EXPO_OVERRIDE_METRO_CONFIG = '/w/app/custom-metro.cjs';
    const calls: { opts: SpawnOptions }[] = [];
    await startExpoServer({
      root,
      port: 8120,
      logsDir: join(root, '.stim', 'logs'),
      spawnFn: (_cmd, _args, opts) => {
        calls.push({ opts });
        return fakeChild();
      },
    });
    const env = calls[0]?.opts.env as Record<string, string>;
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(env.EXPO_OVERRIDE_METRO_CONFIG).toContain('expo-metro-config.cjs');
    expect(env.STIM_EXPO_METRO_CONFIG).toBe('/w/app/custom-metro.cjs');
    expect(env.STIM_METRO_STORE).toBe(metroStoreRoot(root));
    expect(env.STIM_PROJECT_ROOT).toBe(root);
    expect(env.FORCE_COLOR).toBe('0');
    delete process.env.EXPO_OVERRIDE_METRO_CONFIG;
  });

  test('Expo SDK 53 runs normally without Stim Metro cache env or request records', async () => {
    fakeBin(root, 53);
    const logsDir = join(root, '.stim', 'logs');
    const calls: { opts: SpawnOptions }[] = [];
    const handle = await startExpoServer({
      root,
      port: 8119,
      logsDir,
      spawnFn: (_cmd, _args, opts) => {
        calls.push({ opts });
        return fakeChild();
      },
    });
    const env = calls[0]?.opts.env as Record<string, string>;
    expect(expoSdkMajor(root)).toBe(53);
    expect(env.EXPO_OVERRIDE_METRO_CONFIG).toBe(undefined);
    expect(env.STIM_METRO_STORE).toBe(undefined);
    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
    expect(String(records.find((record) => record.event === 'cache_store_skipped')?.msg)).toContain('predates');
    expect(handle.observesRequests).toBe(false);
  });

  test.each(['machine', 'project', 'native-invalid'])(
    '%s Metro opt-out leaves NODE_OPTIONS exactly as the caller set it',
    async (layer) => {
      writeFileSync(
        join(tmpHome, 'config.json'),
        JSON.stringify({
          projects: {},
          repos: {},
          optimizations: { metroSharedCache: layer !== 'machine' },
        }),
      );
      if (layer === 'project' || layer === 'native-invalid')
        writeFileSync(
          join(root, '.stim.json'),
          JSON.stringify({
            optimizations: {
              metroSharedCache: false,
              ...(layer === 'native-invalid'
                ? { android: { compilerCache: 'cas' }, ios: { compilationCache: 'false' } }
                : {}),
            },
          }),
        );
      fakeBin();
      process.env.NODE_OPTIONS = '--enable-source-maps';
      const logsDir = join(root, '.stim', 'logs');
      const calls: { opts: SpawnOptions }[] = [];
      const handle = await startExpoServer({
        root,
        port: 8121,
        logsDir,
        spawnFn: (_cmd, _args, opts) => {
          calls.push({ opts });
          return fakeChild();
        },
      });
      const env = calls[0]?.opts.env as Record<string, string>;
      expect(env.NODE_OPTIONS).toBe('--enable-source-maps');
      expect(env.STIM_METRO_STORE).toBe('');
      expect(env.EXPO_OVERRIDE_METRO_CONFIG).toBe(expoMetroConfigPath());
      expect(handle.observesRequests).toBe(true);
      const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
      expect(records.some((r) => r.event === 'cache_store_skipped')).toBe(true);
    },
  );
});

describe('the honest record of the Metro store injection', () => {
  test('what Stim writes on the way in is the request, not a claim of success', async () => {
    fakeBin();
    const logsDir = join(root, '.stim', 'logs');
    await startExpoServer({ root, port: 8122, logsDir, spawnFn: () => fakeChild() });
    const records = parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
    const requested = records.filter((r) => r.event === 'cache_store_requested');
    expect(requested.length).toBe(1);
    expect(String(requested[0]?.msg)).toContain('asked this project');
    expect(String(requested[0]?.msg)).toContain(metroStoreRoot(root));
    expect(records.some((r) => r.event === 'cache_store_injected')).toBe(false);
    expect(records.some((r) => r.event === 'cache_store_added')).toBe(false);
  });

  test("the adapter's own line is what becomes the confirming record", () => {
    const record = recordFromLine('stim-metro-store: sharing Metro transforms through /cache/app');
    assert(record);
    expect(record.event).toBe('cache_store_added');
    expect(record.level).toBe('debug');
    expect(String(record.msg)).toContain('/cache/app');
    expect(record.raw).toBe(undefined);
  });

  test('the confirmation parser only matches the adapter, and only with a root', () => {
    expect(metroStoreConfirmedRoot('stim-metro-store: sharing Metro transforms through /cache/app')).toBe('/cache/app');
    expect(metroStoreConfirmedRoot('stim-metro-store: sharing Metro transforms through ')).toBe(null);
    expect(metroStoreConfirmedRoot('warning: Stim could not share this project')).toBe(null);
    expect(metroStoreConfirmedRoot('iOS Bundled 812ms index.js (1150 modules)')).toBe(null);
  });

  test('the confirmation is promoted on either stream', () => {
    const line = 'stim-metro-store: sharing Metro transforms through /cache/app';
    expect(recordFromLine(line, { stream: 'stderr' })?.event).toBe('cache_store_added');
    expect(recordFromLine(line, { stream: 'stdout' })?.event).toBe('cache_store_added');
  });

  test("the adapter's failure line is still an ordinary warn record", () => {
    const record = recordFromLine(
      "warning: Stim could not share this project's Metro transform cache (metro-cache exports no FileStore); the dev server is running with the cache it would have had anyway.",
    );
    assert(record);
    expect(record.level).toBe('warn');
    expect(record.raw).toBe(true);
  });
});
