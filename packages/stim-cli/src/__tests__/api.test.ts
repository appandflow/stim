import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { workspaceName } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { createStim, StimError } from '../api.ts';

let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-api-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'caller-home'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string) {
  const root = join(scratch, name);
  const home = join(scratch, `${name}-home`);
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, private: true }));
  const directory = join(home, 'workspaces', workspaceName(root), 'logs');
  mkdirSync(directory, { recursive: true });
  return { root, home, directory };
}

test('concurrent clients read only their own home without changing caller process context', async () => {
  const first = fixture('first');
  const second = fixture('second');
  for (const [at, item] of [first, second].entries()) {
    writeFileSync(
      join(item.directory, 'build.ndjson'),
      JSON.stringify({ ts: at + 1, level: 'error', src: 'build', msg: item.root }) + '\n',
    );
  }
  const cwd = process.cwd();
  const environment = { ...process.env };
  const interrupts = process.listeners('SIGINT');
  const stdout = vi.spyOn(console, 'log');
  const stderr = vi.spyOn(console, 'error');
  try {
    const results = await Promise.all(
      [first, second].map(({ root, home }) => createStim({ projectRoot: root, home }).diagnostics()),
    );
    expect(results).toEqual(
      [first, second].map((item, at) => ({
        directory: item.directory,
        records: [{ ts: at + 1, level: 'error', src: 'build', msg: item.root }],
      })),
    );
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(environment);
    expect(process.listeners('SIGINT')).toEqual(interrupts);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test('a run refusal preserves its error and diagnostics and permits independent cleanup', async () => {
  const { root, home, directory } = fixture('refusal');
  const output: string[] = [];
  const stim = createStim({ projectRoot: root, home, onProgress: ({ message }) => output.push(message) });
  await expect(stim.run({ platform: 'ios' })).rejects.toMatchObject({
    name: 'StimError',
    code: 'STIM_NO_PROJECT',
    details: { logs: directory },
  });
  expect(output.join('')).toContain('STIM_NO_PROJECT');
  expect(await stim.diagnostics()).toEqual({ directory, records: [] });
  expect((await stim.stop()).ok).toBe(true);
});

test('a build refusal preserves its error without starting or stopping a workspace runtime', async () => {
  const { root, home, directory } = fixture('build-refusal');
  const stim = createStim({ projectRoot: root, home });
  await expect(stim.build({ platform: 'android' })).rejects.toMatchObject({
    name: 'StimError',
    code: 'STIM_NO_PROJECT',
    details: { logs: directory },
  });
  expect(await stim.diagnostics()).toEqual({ directory, records: [] });
});

test('aborting a waiting operation leaves other clients usable and cleanup uses a fresh signal', async () => {
  const { root, home } = fixture('cancelled');
  const claim = tryAcquireClaim({
    root: join(home, 'workspaces', workspaceName(root), 'native-run.lock'),
    mode: 'exclusive',
    label: 'API cancellation fixture',
    details: { command: 'ios', platform: 'ios' },
  });
  if (!claim.acquired) throw new Error('Could not acquire fixture claim.');
  const controller = new AbortController();
  const stim = createStim({
    projectRoot: root,
    home,
    onProgress: ({ message }) => {
      if (message.includes('waiting for')) controller.abort();
    },
  });
  try {
    await expect(stim.run({ platform: 'ios', signal: controller.signal })).rejects.toMatchObject({
      code: 'STIM_CANCELLED',
    });
    expect(controller.signal.aborted).toBe(true);
    await expect(stim.diagnostics()).resolves.toMatchObject({ records: [] });
  } finally {
    releaseClaim(claim.acquired);
  }
  expect((await stim.stop()).ok).toBe(true);
});

test('an already aborted request does not start work and invalid paths fail before starting work', async () => {
  const { root, home } = fixture('invalid');
  const stim = createStim({ projectRoot: root, home });
  const controller = new AbortController();
  controller.abort();
  await expect(stim.run({ platform: 'ios', signal: controller.signal })).rejects.toBeInstanceOf(StimError);
  await expect(stim.build({ platform: 'android', signal: controller.signal })).rejects.toMatchObject({
    code: 'STIM_CANCELLED',
  });
  await expect(stim.diagnostics({ tail: -1 })).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
  expect(() => createStim({ projectRoot: root, home: './relative' })).toThrow('home must be an absolute path');
  expect(() => createStim({ projectRoot: join(root, 'missing') })).toThrowError(
    expect.objectContaining({
      name: 'StimError',
      code: 'STIM_NO_PROJECT',
      remedy: 'Pass the path to an existing, readable app directory.',
    }),
  );
});

test('client home stays stable if the caller later changes its environment', async () => {
  const first = fixture('stable-home');
  vi.stubEnv('STIM_HOME', first.home);
  const stim = createStim({ projectRoot: first.root });
  vi.stubEnv('STIM_HOME', join(scratch, 'changed-home'));
  expect((await stim.diagnostics()).directory).toBe(first.directory);
});

test('relative inherited state paths refuse instead of falling back to the real home', async () => {
  const { root } = fixture('relative-home');
  vi.stubEnv('STIM_HOME', 'relative');
  const stim = createStim({ projectRoot: root });
  await expect(stim.diagnostics()).rejects.toMatchObject({ code: 'STIM_RELATIVE_PATH' });
});

test('a throwing progress callback interrupts its worker and rejects without preventing cleanup', async () => {
  const { root, home } = fixture('progress-failure');
  const claim = tryAcquireClaim({
    root: join(home, 'workspaces', workspaceName(root), 'native-run.lock'),
    mode: 'exclusive',
    label: 'API progress failure fixture',
    details: { command: 'ios', platform: 'ios' },
  });
  if (!claim.acquired) throw new Error('Could not acquire fixture claim.');
  const spawned: ChildProcess[] = [];
  const executor = getExecutor();
  const spawn = executor.spawn.bind(executor);
  const observer = vi.spyOn(executor, 'spawn').mockImplementation((...args) => {
    const child = spawn(...args);
    spawned.push(child);
    return child;
  });
  const failure = new Error('The progress sink failed.');
  let output = '';
  let threw = false;
  const stim = createStim({
    projectRoot: root,
    home,
    onProgress: ({ message }) => {
      output += message;
      if (!threw && output.includes('waiting for')) {
        threw = true;
        throw failure;
      }
    },
  });
  try {
    await expect(stim.run({ platform: 'ios' })).rejects.toBe(failure);
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  } finally {
    observer.mockRestore();
    releaseClaim(claim.acquired);
  }
  expect((await stim.stop()).ok).toBe(true);
});

test('settings reads run in process against each client home and leave the caller context unchanged', async () => {
  const first = fixture('settings-first');
  const second = fixture('settings-second');
  writeFileSync(join(first.home, 'config.json'), JSON.stringify({ archive: { maxCount: 7 } }));
  writeFileSync(join(second.home, 'config.json'), JSON.stringify({ archive: { maxCount: 9 } }));
  const cwd = process.cwd();
  const environment = { ...process.env };
  const interrupts = process.listeners('SIGINT');
  const spawn = vi.spyOn(getExecutor(), 'spawn');
  const stdout = vi.spyOn(console, 'log');
  try {
    const payloads = await Promise.all(
      [first, second].map(({ root, home }) => createStim({ projectRoot: root, home }).settings()),
    );
    expect(
      payloads.map((payload) => ({
        project: payload.project,
        machine: payload.files.machine,
        maxCount: payload.settings.find((entry) => entry.key === 'archive.maxCount'),
      })),
    ).toEqual(
      [first, second].map((item, at) => ({
        project: item.root,
        machine: join(item.home, 'config.json'),
        maxCount: { key: 'archive.maxCount', value: 7 + 2 * at, origin: 'machine', layers: { machine: 7 + 2 * at } },
      })),
    );
    expect(spawn).not.toHaveBeenCalledWith(process.execPath, expect.anything(), expect.anything());
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(environment);
    expect(process.listeners('SIGINT')).toEqual(interrupts);
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
    stdout.mockRestore();
  }
});

test.skipIf(process.platform === 'win32')(
  "each client's children get its own home and run id instead of the caller's",
  async () => {
    const clients = ['children-first', 'children-second'].map((name) => {
      const item = fixture(name);
      const bin = join(scratch, `${name}-bin`);
      const seen = join(scratch, `${name}-seen`);
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'git'),
        `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(seen)}, process.env.STIM_HOME + ' ' + process.env.STIM_RUN_ID + '\\n');\nprocess.exit(1);\n`,
      );
      chmodSync(join(bin, 'git'), 0o755);
      const env = { PATH: `${bin}:${process.env.PATH}`, HOME: scratch };
      return { home: item.home, seen, stim: createStim({ projectRoot: item.root, home: item.home, env }) };
    });
    await Promise.all(clients.map(({ stim }) => stim.settings()));
    const runIds = clients.map(({ home, seen }) => {
      const lines = readFileSync(seen, 'utf8').trim().split('\n');
      expect(lines.map((line) => line.split(' ')[0])).toEqual(lines.map(() => home));
      const ids = new Set(lines.map((line) => line.split(' ')[1]));
      expect(ids.size).toBe(1);
      return [...ids][0];
    });
    expect(runIds[0]).not.toBe(runIds[1]);
  },
);

test('stop runs in the calling process and reports through onProgress without touching the caller context', async () => {
  const { root, home } = fixture('stop-in-process');
  const output: string[] = [];
  const cwd = process.cwd();
  const environment = { ...process.env };
  const interrupts = process.listeners('SIGINT');
  const spawn = vi.spyOn(getExecutor(), 'spawn');
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  try {
    const result = await createStim({
      projectRoot: root,
      home,
      onProgress: ({ message }) => output.push(message),
    }).stop();
    expect(result).toMatchObject({ ok: true });
    expect(spawn).not.toHaveBeenCalledWith(process.execPath, expect.anything(), expect.anything());
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(output.join('')).not.toBe('');
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(environment);
    expect(process.listeners('SIGINT')).toEqual(interrupts);
  } finally {
    spawn.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
});

test('an in-process stop refusal keeps the log path, and a throwing onProgress rejects with its own error', async () => {
  const { root, home, directory } = fixture('stop-refusal');
  await expect(createStim({ projectRoot: root, home }).stop({ slot: 'missing' })).rejects.toMatchObject({
    name: 'StimError',
    code: 'STIM_BAD_ARG',
    details: { logs: directory },
  });
  const thrown = new Error('progress consumer failed');
  const calls: string[] = [];
  const stim = createStim({
    projectRoot: root,
    home,
    onProgress: ({ message }) => {
      calls.push(message);
      throw thrown;
    },
  });
  await expect(stim.stop()).rejects.toBe(thrown);
  expect(calls).toHaveLength(1);
});

test('a settings refusal rejects with its code and remedy, and an aborted read does not start', async () => {
  const { root, home } = fixture('settings-refusal');
  vi.stubEnv('STIM_BUDGET_MIN_FREE_DISK_GB', 'lots');
  const stim = createStim({ projectRoot: root, home });
  await expect(stim.settings()).rejects.toMatchObject({
    name: 'StimError',
    code: 'STIM_BAD_ARG',
    message: 'Invalid STIM_BUDGET_MIN_FREE_DISK_GB value "lots". Expected a number, 0 or more.',
    remedy: expect.stringContaining('stim settings set budget.minFreeDiskGb'),
  });
  const controller = new AbortController();
  controller.abort();
  await expect(stim.settings({ signal: controller.signal })).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  vi.stubEnv('STIM_HOME', 'relative');
  await expect(createStim({ projectRoot: root }).settings()).rejects.toMatchObject({ code: 'STIM_RELATIVE_PATH' });
});

test('a settings read uses only the client environment for its default home and its Git children', async () => {
  const { root } = fixture('settings-env');
  const userHome = join(scratch, 'user');
  mkdirSync(join(userHome, '.stim'), { recursive: true });
  getExecutor().runFile('git', ['init', '-q', root], { timeoutMs: 60_000 });
  const stim = createStim({ projectRoot: root, env: { PATH: process.env.PATH, HOME: userHome } });
  vi.stubEnv('GIT_DIR', join(scratch, 'missing.git'));
  const payload = await stim.settings();
  expect(payload.files.machine).toBe(join(userHome, '.stim', 'config.json'));
  expect(payload.files.repo).toContain(`repos["${realpathSync(join(root, '.git'))}"]`);
});

test('aborting a settings read kills its Stim Desktop lookup', async () => {
  const { root, home } = fixture('settings-abort');
  const executor = getExecutor();
  const real = executor.runFileAsync.bind(executor);
  let lookup: ChildProcess | null = null;
  let ended: NodeJS.Signals | null = null;
  const spy = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, opts) => {
    if (file !== 'osascript') return real(file, args, opts);
    const child = executor.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    lookup = child;
    opts.onSpawn?.(child);
    return new Promise((resolve) =>
      child.once('exit', (_code, signal) => {
        ended = signal;
        resolve('');
      }),
    );
  });
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  try {
    const controller = new AbortController();
    const read = createStim({ projectRoot: root, home, env: { PATH: process.env.PATH } }).settings({
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(lookup).not.toBeNull());
    controller.abort();
    await expect(read).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    await vi.waitFor(() => expect(ended).toBe('SIGKILL'));
  } finally {
    spy.mockRestore();
    vi.restoreAllMocks();
  }
});

test('settings reads sharing one signal leave no abort listeners behind, even when Git cannot start', async () => {
  const { root, home } = fixture('settings-listeners');
  getExecutor().runFile('git', ['init', '-q', root], { timeoutMs: 60_000 });
  const controller = new AbortController();
  const added = vi.spyOn(controller.signal, 'addEventListener');
  const removed = vi.spyOn(controller.signal, 'removeEventListener');
  const found = createStim({ projectRoot: root, home });
  const missing = createStim({ projectRoot: root, home, env: { PATH: join(scratch, 'no-bin') } });
  for (let i = 0; i < 3; i++) {
    await found.settings({ signal: controller.signal });
    await missing.settings({ signal: controller.signal });
  }
  expect(added.mock.calls.length).toBeGreaterThan(0);
  await vi.waitFor(() => expect(removed.mock.calls.length).toBe(added.mock.calls.length));
});

test('logs clients read independent homes with bounded tails and reject invalid filters', async () => {
  const first = fixture('logs-first');
  const second = fixture('logs-second');
  for (const item of [first, second])
    writeFileSync(
      join(item.directory, 'client.ndjson'),
      [1, 2, 3].map((ts) => JSON.stringify({ ts, src: 'client', level: 'info', msg: item.root })).join('\n') + '\n',
    );
  const environment = { ...process.env };
  const spawn = vi.spyOn(getExecutor(), 'spawn');
  try {
    const results = await Promise.all(
      [first, second].map((item) => createStim({ projectRoot: item.root, home: item.home }).logs({ tail: 1 })),
    );
    expect(results).toEqual([first, second].map((item) => [{ ts: 3, src: 'client', level: 'info', msg: item.root }]));
    expect(spawn).not.toHaveBeenCalled();
    expect(process.env).toEqual(environment);
    const stim = createStim({ projectRoot: first.root, home: first.home });
    for (const options of [
      { tail: -1 },
      { tail: 0.5 },
      { sources: ['missing'] },
      { minLevel: 'loud' },
      { since: '5m', grep: '(' },
    ])
      await expect(stim.logs(options)).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
    expect(await stim.logs({ tail: 0 })).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    await expect(stim.logs({ signal: abort.signal })).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  } finally {
    spawn.mockRestore();
  }
});
