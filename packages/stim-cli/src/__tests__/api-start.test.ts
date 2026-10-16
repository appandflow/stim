import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
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

test('cancelling startup drains dynamic Expo config and its helper before releasing ownership', async () => {
  const root = join(scratch, 'dynamic-config');
  const home = join(scratch, 'dynamic-config-home');
  const bin = join(root, 'node_modules', 'expo', 'cli.cjs');
  const ready = join(root, 'config-ready.json');
  mkdirSync(join(root, 'node_modules', 'expo'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', 'expo', 'package.json'),
    JSON.stringify({ name: 'expo', bin: { expo: 'cli.cjs' } }),
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
  writeFileSync(join(root, 'app.config.js'), 'module.exports = {};');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const {spawn} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(bin, 0o755);
  const abort = new AbortController();
  const outcome = createStim({ projectRoot: root, home })
    .start({ signal: abort.signal })
    .catch((error: unknown) => error);
  const records: { pid: number; processToken: string }[] = [];
  try {
    const startupDeadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < startupDeadline) await delay(5);
    expect(existsSync(ready)).toBe(true);
    const pids: { parent: number; child: number } = JSON.parse(readFileSync(ready, 'utf8'));
    for (const pid of Object.values(pids)) {
      const processToken = captureProcessToken(pid);
      assert(processToken);
      records.push({ pid, processToken });
    }
    abort.abort();
    expect(await Promise.race([outcome, delay(2000, 'still evaluating config')])).toMatchObject({
      code: 'STIM_CANCELLED',
    });
    for (const record of records) {
      const cleanupDeadline = Date.now() + 1000;
      while (inspectProcessIdentity(record) !== 'gone' && Date.now() < cleanupDeadline) await delay(5);
      expect(inspectProcessIdentity(record)).toBe('gone');
    }
    const next = tryAcquireClaim({
      root: join(home, 'workspaces', workspaceName(root), 'metro-start.lock'),
      mode: 'exclusive',
    });
    if (next.acquired) releaseClaim(next.acquired);
    expect(Boolean(next.acquired)).toBe(true);
  } finally {
    abort.abort();
    for (const record of records) if (inspectProcessIdentity(record) === 'same') process.kill(record.pid, 'SIGKILL');
    await outcome;
  }
});

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

test('reset-cache startup yields while native ownership inspection is pending', async () => {
  const item = await metroFixture('reset-responsive', 999999910);
  const real = getExecutor();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let probing!: () => void;
  const probe = new Promise<void>((resolve) => {
    probing = resolve;
  });
  setExecutor({
    ...real,
    runFileQuiet: (file, args, options) => {
      if (file === 'lsof') return String(item.pid);
      return real.runFileQuiet(file, args, options);
    },
    runFileQuietAsync: async (file, args, options) => {
      if (file !== 'lsof') return real.runFileQuietAsync(file, args, options);
      probing();
      await gate;
      return String(item.pid);
    },
  });
  let settled = false;
  const pending = createStim({ projectRoot: item.root, home: item.home })
    .start({ resetCache: true })
    .catch((error: unknown) => error);
  void pending.then(() => (settled = true));
  try {
    expect(await Promise.race([probe.then(() => 'probing'), pending.then(() => 'completed')])).toBe('probing');
    await delay(20);
    expect(settled).toBe(false);
  } finally {
    release();
    expect(await pending).toMatchObject({ code: 'STIM_SUPERVISOR_EXITED' });
  }
});

test('normal-home startup enforces the configured disk floor before spawning', async () => {
  const root = join(scratch, 'budget-app');
  const userHome = join(scratch, 'budget-user');
  const home = join(userHome, '.stim');
  mkdirSync(root);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 2,
      projects: {},
      repos: {},
      budget: {
        minFreeDiskGb: 0,
        hardFloorDiskGb: 1_000_000,
        maxCommittedMemoryGb: 0,
        maxLiveWorkspaces: 0,
      },
    }),
  );
  const real = getExecutor();
  const spawn = vi.fn<typeof real.spawn>(() => {
    throw new Error('startup bypassed its disk floor');
  });
  let measuring!: () => void;
  const measured = new Promise<void>((resolve) => {
    measuring = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setExecutor({
    ...real,
    spawn,
    runFile: () => '',
    runFileQuiet: () => '',
    runFileQuietAsync: async () => '',
    runFileAsync: async (file) => {
      if (file === 'du') {
        measuring();
        await gate;
      }
      return '';
    },
  });
  const pending = createStim({
    projectRoot: root,
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome, STIM_HOME: undefined, STIM_MAINTENANCE: 'off' },
  })
    .start()
    .catch((error: unknown) => error);
  try {
    expect(await Promise.race([measured.then(() => 'measuring'), pending.then(() => 'completed')])).toBe('measuring');
    await delay(20);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    release();
    expect(await pending).toMatchObject({ code: 'STIM_LOW_DISK' });
  }
  expect(spawn).not.toHaveBeenCalled();
});
