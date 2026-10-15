import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { workspaceName } from '@stim-cli/core';
import { createStim } from '../api.ts';
import type { ChildProcess } from 'node:child_process';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';

let scratch: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-api-start-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'caller-home'));
});

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

async function metroFixture(name: string, pid: number) {
  const root = join(scratch, name);
  const home = join(scratch, `${name}-home`);
  mkdirSync(root);
  mkdirSync(home);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end('packager-status:running');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ version: 2, projects: { [root]: { metroPort: port, platforms: {} } }, repos: {} }),
  );
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const output: string[] = [];
  return { root, home, pid, port, output, requests: () => requests };
}

function useExistingMetros(fixtures: Awaited<ReturnType<typeof metroFixture>>[]) {
  const real = getExecutor();
  const spawn = vi.fn<typeof real.spawn>(() => {
    throw new Error('a healthy existing Metro must not spawn a supervisor');
  });
  setExecutor({
    ...real,
    spawn,
    runFileQuietAsync: async (file, args, options) => {
      if (file === 'lsof') return String(fixtures.find((item) => args?.includes(`-iTCP:${item.port}`))?.pid ?? '');
      return real.runFileQuietAsync(file, args, options);
    },
    runFileAsync: async (file, args, options) => {
      if (file === 'lsof') {
        const item = fixtures.find((candidate) => args?.includes(String(candidate.pid)));
        return item ? `p${item.pid}\nfcwd\nn${item.root}\n` : '';
      }
      return real.runFileAsync(file, args, options);
    },
  });
  return spawn;
}

test('concurrent start clients reuse their own Metro without changing caller context or spawning a supervisor', async () => {
  const first = await metroFixture('first', 999999901);
  const second = await metroFixture('second', 999999902);
  const fixtures = [first, second];
  const spawn = useExistingMetros(fixtures);
  const env = { ...process.env };
  const cwd = process.cwd();
  const interrupts = process.listeners('SIGINT');
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  try {
    const results = await Promise.all(
      fixtures.map((item) =>
        createStim({
          projectRoot: item.root,
          home: item.home,
          onProgress: ({ message }) => item.output.push(message),
        }).start(),
      ),
    );
    expect(results.map(({ port }) => port)).toEqual([first.port, second.port]);
    for (const item of fixtures) {
      expect(results.find((result) => result.port === item.port)).toMatchObject({
        alreadyRunning: true,
        supervisorPid: null,
      });
      expect(item.requests()).toBeGreaterThan(0);
      expect(
        JSON.parse(readFileSync(join(item.home, 'workspaces', workspaceName(item.root), 'state.json'), 'utf8')),
      ).toMatchObject({
        lastUsedAt: expect.any(String),
      });
      expect(item.output.join('')).toContain(String(item.port));
      for (const other of fixtures.filter((candidate) => candidate !== item)) {
        expect(item.output.join('')).not.toContain(String(other.port));
      }
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(process.env).toEqual(env);
    expect(process.cwd()).toBe(cwd);
    expect(process.listeners('SIGINT')).toEqual(interrupts);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test.skipIf(process.platform === 'win32')(
  'start hands a real supervisor to its workspace and a later call reuses it',
  async () => {
    const root = join(scratch, 'owned-supervisor');
    const home = join(scratch, 'owned-supervisor-home');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
    const entry = join(root, 'server.mjs');
    writeFileSync(
      entry,
      "import {createServer} from 'node:http'; createServer((req,res)=>res.end('packager-status:running')).listen(Number(process.argv[2]), '127.0.0.1');",
    );
    writeFileSync(
      join(root, '.stim.json'),
      JSON.stringify({ metro: { command: [process.execPath, entry, '{port}'], tunnel: 'off' } }),
    );
    const real = getExecutor();
    const children: ChildProcess[] = [];
    const tokens = new Map<ChildProcess, string>();
    setExecutor({
      ...real,
      spawn: (file, args, options) => {
        const child = real.spawn(file, args, options);
        children.push(child);
        const token = child.pid && captureProcessToken(child.pid);
        if (token) tokens.set(child, token);
        return child;
      },
    });
    const client = createStim({ projectRoot: root, home, env: { ...process.env, STIM_MAINTENANCE: 'off' } });
    try {
      const first = await client.start({ waitSeconds: 10 });
      expect(first.alreadyRunning).toBe(false);
      const child = children.find((candidate) => candidate.pid === first.supervisorPid);
      assert(child?.pid);
      expect(inspectProcessIdentity({ pid: child.pid, processToken: captureProcessToken(child.pid) })).toBe('same');
      const state = JSON.parse(readFileSync(join(home, 'workspaces', workspaceName(root), 'state.json'), 'utf8'));
      expect(state.supervisor.pid).toBe(child.pid);
      expect(inspectProcessIdentity(state.supervisor)).toBe('same');
      expect(await client.start({ waitSeconds: 10 })).toMatchObject({
        alreadyRunning: true,
        supervisorPid: first.supervisorPid,
        port: first.port,
      });
      expect(children).toHaveLength(1);
      expect(await client.stop()).toMatchObject({ ok: true });
    } finally {
      await client.stop().catch(() => {});
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        if (child.pid && inspectProcessIdentity({ pid: child.pid, processToken: tokens.get(child) }) === 'same') {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }
        child.kill('SIGKILL');
        await exited;
      }
    }
  },
  30_000,
);

test('start admission resolves the app once and refuses before usage, config changes or Metro probes', async () => {
  const item = await metroFixture('refused', 999999903);
  const child = join(item.root, 'nested');
  mkdirSync(child);
  const config = readFileSync(join(item.home, 'config.json'), 'utf8');
  const refused = Object.assign(new Error('busy workspace'), { code: 'STIM_ADMISSION_REFUSED' });
  const resolved: string[] = [];
  const client = createStim({ projectRoot: child, home: item.home });
  await expect(
    client.start({
      beforeStart: (root) => {
        resolved.push(root);
        throw refused;
      },
    }),
  ).rejects.toMatchObject({ code: 'STIM_ADMISSION_REFUSED' });
  expect(resolved).toEqual([item.root]);
  expect(item.requests()).toBe(0);
  expect(readFileSync(join(item.home, 'config.json'), 'utf8')).toBe(config);
  expect(existsSync(join(item.home, 'workspaces'))).toBe(false);
});

test('cancelling start while another owner holds its startup lock releases the request without waiting for that owner', async () => {
  const item = await metroFixture('locked', 999999904);
  const area = join(item.home, 'workspaces', workspaceName(item.root));
  mkdirSync(area, { recursive: true });
  const claim = tryAcquireClaim({ root: join(area, 'metro-start.lock'), mode: 'exclusive', label: 'fixture startup' });
  assert(claim.acquired);
  const controller = new AbortController();
  const completed = createStim({ projectRoot: item.root, home: item.home })
    .start({ signal: controller.signal })
    .catch((cause: unknown) => cause);
  try {
    const deadline = performance.now() + 2000;
    while (!existsSync(join(area, 'state.json')) && performance.now() < deadline) await delay(5);
    expect(existsSync(join(area, 'state.json'))).toBe(true);
    await nextTurn();
    controller.abort();
    expect(await Promise.race([completed, delay(200, 'pending')])).toMatchObject({ code: 'STIM_CANCELLED' });
    expect(item.requests()).toBe(0);
  } finally {
    releaseClaim(claim.acquired);
    await completed;
  }
});

test('startup metadata waits asynchronously so its config-lock owner can query the same process', async () => {
  const item = await metroFixture('config-locked', 999999905);
  const ready = join(scratch, 'config-owner-ready');
  const result = join(scratch, 'config-owner-result.json');
  const state = join(item.home, 'workspaces', workspaceName(item.root), 'state.json');
  const real = getExecutor();
  const owner = real.runFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { existsSync, writeFileSync } from 'node:fs';
        import { setTimeout as delay } from 'node:timers/promises';
        process.env.STIM_HOME = ${JSON.stringify(item.home)};
        const { tryAcquireClaim, releaseClaim } = await import(${JSON.stringify(new URL('../ownership-claim.ts', import.meta.url).href)});
        const claim = tryAcquireClaim({ root: ${JSON.stringify(join(item.home, 'config.lock.claims'))}, mode: 'exclusive', label: 'config owner' });
        if (!claim.acquired) throw new Error('fixture could not own the config lock');
        try {
          writeFileSync(${JSON.stringify(ready)}, 'ready');
          const deadline = Date.now() + 5000;
          while (!existsSync(${JSON.stringify(state)}) && Date.now() < deadline) await delay(5);
          const responsive = await fetch('http://127.0.0.1:${item.port}/status', { signal: AbortSignal.timeout(250) }).then(
            (response) => response.ok,
            () => false,
          );
          writeFileSync(${JSON.stringify(result)}, JSON.stringify({ responsive }));
        } finally {
          releaseClaim(claim.acquired);
        }
      `,
    ],
    { timeoutMs: 10_000 },
  );
  const closed = owner.catch((cause: unknown) => cause);
  try {
    const deadline = performance.now() + 5000;
    while (!existsSync(ready) && performance.now() < deadline) await delay(5);
    expect(existsSync(ready)).toBe(true);
    const spawn = useExistingMetros([item]);
    const facts = await createStim({ projectRoot: item.root, home: item.home }).start();
    await owner;
    expect(facts).toMatchObject({ port: item.port, alreadyRunning: true });
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ responsive: true });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await closed;
  }
}, 15_000);
