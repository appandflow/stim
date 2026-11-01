import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { workspaceName } from '@stim-cli/core';
import { readWorkspaceState } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { deviceLeaseLockPath, deviceLeasePath, takeLease } from '../engine/device-lease.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { createStim, StimError } from '../api.ts';
import * as hostedLogs from '../device-host/hosted-logs-sync.ts';

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

test('home identities persist across clients and separate homes under concurrent initialization', async () => {
  const first = fixture('first');
  const second = fixture('second');
  const make = (item: typeof first) => createStim({ projectRoot: item.root, home: item.home });
  const [one, same, other] = await Promise.all([
    make(first).identity(),
    make(first).identity(),
    make(second).identity(),
  ]);
  expect(one).toBe(same);
  expect(one).not.toBe(other);
  expect(await make(first).identity()).toBe(one);
  expect(JSON.parse(readFileSync(join(first.home, 'config.json'), 'utf8')).homeId).toBe(one);
  expect(JSON.parse(readFileSync(join(second.home, 'config.json'), 'utf8')).homeId).toBe(other);
});

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
  const spawn = vi.spyOn(getExecutor(), 'spawn').mockImplementation(() => {
    throw new Error('Diagnostics must work without permission to spawn a child');
  });
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
    spawn.mockRestore();
  }
});

test('diagnostics preserves local tail, error filtering and missing log directory results', async () => {
  const { root, home, directory } = fixture('diagnostics');
  const records = [
    { ts: 1, src: 'build', level: 'info', msg: 'first' },
    { ts: 2, src: 'build', level: 'error', msg: 'failure' },
    { ts: 3, src: 'build', level: 'info', msg: 'last' },
  ];
  writeFileSync(join(directory, 'build.ndjson'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const stim = createStim({ projectRoot: root, home });
  expect(await stim.diagnostics({ tail: 1 })).toEqual({ directory, records: [records[2]] });
  expect(await stim.diagnostics({ errors: true })).toEqual({ directory, records: [records[1]] });
  expect(await stim.diagnostics({ tail: 0 })).toEqual({ directory, records: [] });
  rmSync(directory, { recursive: true });
  expect(await stim.diagnostics()).toEqual({ directory, records: [] });
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

test('native build and run refusals stay in the caller process and keep concurrent client output separate', async () => {
  const first = fixture('native-first');
  const second = fixture('native-second');
  const cwd = process.cwd();
  const environment = { ...process.env };
  const listeners = ['SIGINT', 'SIGTERM', 'exit'].map((event) => process.rawListeners(event));
  const output: string[] = [];
  const stdout = vi.spyOn(console, 'log');
  const stderr = vi.spyOn(console, 'error');
  const spawn = vi.spyOn(getExecutor(), 'spawn').mockImplementation(() => {
    throw new Error('A project refusal must not need a lifecycle worker.');
  });
  const checkHost = () => {
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(environment);
    expect(['SIGINT', 'SIGTERM', 'exit'].map((event) => process.rawListeners(event))).toEqual(listeners);
  };
  try {
    const one = createStim({
      projectRoot: first.root,
      home: first.home,
      onProgress: ({ message }) => {
        checkHost();
        output.push(message);
      },
    });
    const two = createStim({ projectRoot: second.root, home: second.home });
    await Promise.all([
      expect(one.run({ platform: 'ios' })).rejects.toMatchObject({
        code: 'STIM_NO_PROJECT',
        details: { logs: first.directory },
      }),
      expect(two.build({ platform: 'android' })).rejects.toMatchObject({
        code: 'STIM_NO_PROJECT',
        details: { logs: second.directory },
      }),
    ]);
    expect(output.join('')).toContain('STIM_NO_PROJECT');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    checkHost();
  } finally {
    spawn.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
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
  await expect(stim.diagnostics({ signal: controller.signal })).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
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

test('a throwing progress callback cancels its native lock wait and rejects without preventing cleanup', async () => {
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
    expect(spawned).toEqual([]);
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

test.each(['config', 'metadata', 'workspace', 'browser', 'lease'])(
  'aborted stop finishes cleanup without blocking the caller on its %s lock',
  async (kind) => {
    const { root, home } = fixture('stop-config-contention');
    const supervisor = JSON.parse(
      await getExecutor().runFileAsync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { captureProcessIdentity } from ${JSON.stringify(import.meta.resolve('@stim-cli/core/process-identity'))};
const identity = captureProcessIdentity(process.pid);
if (!identity.ok) throw new Error(identity.reason);
console.log(JSON.stringify({ pid: process.pid, processToken: identity.token }));`,
        ],
        { timeoutMs: 10_000 },
      ),
    );
    const file = join(home, 'config.json');
    const config = JSON.stringify({ projects: { [root]: { supervisor } } });
    writeFileSync(file, config);
    vi.stubEnv('STIM_HOME', home);
    const area = join(home, 'workspaces', workspaceName(root));
    if (kind === 'browser') {
      writeFileSync(
        join(area, 'state.json'),
        JSON.stringify({
          web: {
            ...supervisor,
            cdpPort: 19449,
            profile: join(area, 'web', 'profile'),
            url: 'http://localhost',
            chrome: 'fixture',
          },
        }),
      );
    }
    if (kind === 'lease') {
      const lease = takeLease({ root, platform: 'android', id: 'fixture-phone', kind: 'run' });
      if (lease.status !== 'taken') throw new Error('Could not take the fixture lease.');
    }
    const lock =
      kind === 'config'
        ? join(home, 'config.lock')
        : kind === 'metadata'
          ? join(area, 'metadata.lock')
          : kind === 'workspace' || kind === 'browser'
            ? join(area, 'state.lock')
            : deviceLeaseLockPath('android', 'fixture-phone');
    mkdirSync(lock);
    const controller = new AbortController();
    let ticked = false;
    let whileLocked = '';
    const cancel = setTimeout(() => {
      ticked = true;
      controller.abort();
    }, 10);
    const release = setTimeout(() => {
      whileLocked = readFileSync(file, 'utf8');
      rmSync(lock, { recursive: true });
    }, 50);
    try {
      await expect(createStim({ projectRoot: root, home }).stop({ signal: controller.signal })).rejects.toMatchObject({
        code: 'STIM_CANCELLED',
      });
      expect(ticked).toBe(true);
      expect(whileLocked).toBe(config);
      expect(JSON.parse(readFileSync(file, 'utf8')).projects[root].supervisor).toBeUndefined();
      expect(readWorkspaceState(root)?.deviceLeases).toBeUndefined();
      expect(readWorkspaceState(root)?.web).toBeUndefined();
    } finally {
      clearTimeout(cancel);
      clearTimeout(release);
      controller.abort();
      rmSync(lock, { recursive: true, force: true });
    }
  },
);

test('stop requests native cancellation through a contended state lock and clears its request', async () => {
  const { root, home } = fixture('stop-native-request');
  vi.stubEnv('STIM_HOME', home);
  const area = join(home, 'workspaces', workspaceName(root));
  const claim = tryAcquireClaim({
    root: join(area, 'native-run.lock'),
    mode: 'exclusive',
    label: 'Native run fixture',
    details: { command: 'ios' },
  });
  if (!claim.acquired) throw new Error('Could not acquire fixture claim.');
  const lock = join(area, 'state.lock');
  mkdirSync(lock);
  let observed = false;
  const release = setTimeout(() => rmSync(lock, { recursive: true }), 50);
  const observe = setInterval(() => {
    if (!readWorkspaceState(root)?.nativeRunCancel) return;
    observed = true;
    releaseClaim(claim.acquired);
  }, 10);
  try {
    const result = await createStim({ projectRoot: root, home }).stop();
    expect(result.ok).toBe(true);
    expect(observed).toBe(true);
    expect(readWorkspaceState(root)?.nativeRunCancel).toBeUndefined();
  } finally {
    clearTimeout(release);
    clearInterval(observe);
    rmSync(lock, { recursive: true, force: true });
    releaseClaim(claim.acquired);
  }
});

test('stop reports every lease released across lock retries and keeps another workspace lease', async () => {
  const { root, home } = fixture('stop-lease-retries');
  const other = join(scratch, 'other-holder');
  mkdirSync(other);
  vi.stubEnv('STIM_HOME', home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: { [root]: {}, [other]: {} } }));
  for (const slot of ['available', 'blocked']) {
    const lease = takeLease({ root, platform: 'android', slot, id: `${slot}-fixture`, kind: 'run' });
    if (lease.status !== 'taken') throw new Error('Could not take the fixture lease.');
  }
  const foreign = takeLease({ root: other, platform: 'android', id: 'foreign-fixture', kind: 'run' });
  if (foreign.status !== 'taken') throw new Error('Could not take the other workspace lease.');
  const lock = deviceLeaseLockPath('android', 'blocked-fixture');
  mkdirSync(lock);
  const release = setTimeout(() => rmSync(lock, { recursive: true }), 50);
  try {
    const result = await createStim({ projectRoot: root, home }).stop();
    expect(result.ok).toBe(true);
    expect(result.outcomes.releasedLeases.map((lease) => lease.id).toSorted()).toEqual([
      'available-fixture',
      'blocked-fixture',
    ]);
    expect(readWorkspaceState(root)?.deviceLeases).toBeUndefined();
    expect(existsSync(deviceLeasePath('android', 'available-fixture'))).toBe(false);
    expect(existsSync(deviceLeasePath('android', 'blocked-fixture'))).toBe(false);
    expect(JSON.parse(readFileSync(deviceLeasePath('android', 'foreign-fixture'), 'utf8')).holder).toBe(other);
    expect(readWorkspaceState(other)?.deviceLeases).toMatchObject({ android: { id: 'foreign-fixture' } });
  } finally {
    clearTimeout(release);
    rmSync(lock, { recursive: true, force: true });
  }
});

test('cancelling stop leaves another native operation claim held instead of waiting for its release', async () => {
  const { root, home } = fixture('stop-native-contention');
  const claim = tryAcquireClaim({
    root: join(home, 'workspaces', workspaceName(root), 'native-run.lock'),
    mode: 'exclusive',
    label: 'Concurrent stop fixture',
    details: { command: 'stop' },
  });
  if (!claim.acquired) throw new Error('Could not acquire fixture claim.');
  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), 10);
  let released = false;
  const escape = setTimeout(() => {
    released = true;
    releaseClaim(claim.acquired);
  }, 500);
  try {
    await expect(createStim({ projectRoot: root, home }).stop({ signal: controller.signal })).rejects.toMatchObject({
      code: 'STIM_CANCELLED',
    });
    expect(released).toBe(false);
  } finally {
    clearTimeout(cancel);
    clearTimeout(escape);
    controller.abort();
    releaseClaim(claim.acquired);
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
  const windowsRuntime =
    process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot, PSModulePath: process.env.PSModulePath, PATHEXT: process.env.PATHEXT }
      : {};
  const stim = createStim({ projectRoot: root, env: { PATH: process.env.PATH, ...windowsRuntime, HOME: userHome } });
  vi.stubEnv('GIT_DIR', join(scratch, 'missing.git'));
  const payload = await stim.settings();
  expect(payload.files.machine).toBe(join(userHome, '.stim', 'config.json'));
  expect(payload.files.repo).toContain(`repos["${realpathSync.native(join(root, '.git'))}"]`);
  const scoped = await createStim({
    projectRoot: root,
    home: join(userHome, '.stim'),
    env: { PATH: process.env.PATH, ...windowsRuntime },
  }).settings();
  for (const [key, normal, isolated] of [
    ['archive.enabled', true, false],
    ['maintenance.mode', 'on', 'off'],
    ['budget.minFreeDiskGb', 20, 0],
  ] as const) {
    expect(payload.settings.find((entry) => entry.key === key)).toMatchObject({ value: normal, origin: 'default' });
    expect(scoped.settings.find((entry) => entry.key === key)).toMatchObject({ value: isolated, origin: 'env' });
  }
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

test('assembled agent tails filter before selection and preserve equal-timestamp ordering across sessions', async () => {
  const { root, home, directory } = fixture('agent-tail');
  const state = join(scratch, 'agent-state');
  const deviceUdid = '1F11A62B-F7CF-435D-BD1B-0FA926895E93';
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ projects: { [root]: { platforms: { ios: { owned: true, deviceUdid } } } } }),
  );
  writeFileSync(
    join(directory, 'device.ndjson'),
    JSON.stringify({ ts: 1, src: 'device', level: 'info', msg: 'start' }) + '\n',
  );
  for (const session of ['first', 'second']) {
    const dir = join(state, 'sessions', session);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'runner.log'),
      `-destination "platform=iOS Simulator,id=${deviceUdid}"\n2026-09-25 12:00:00.000+0000 Runner started\n`,
    );
    const lines = Array.from({ length: 12000 }, (_, index) =>
      JSON.stringify({
        version: 1,
        ts: new Date(Date.parse('2026-10-09T12:00:00Z') + Math.floor(index / 4)).toISOString(),
        session,
        kind: 'action.recorded',
        command: 'press',
        summary: `${session}:${index}${index < 100 ? ':wanted' : ''}`,
        details: { platform: 'ios' },
      }),
    );
    writeFileSync(join(dir, 'events.ndjson'), lines.join('\n') + '\n');
  }
  const stim = createStim({
    projectRoot: root,
    home,
    env: {
      ...process.env,
      HOME: scratch,
      AGENT_DEVICE_STATE_DIR: state,
      AGENT_DEVICE_CLAIMS_DIR: join(scratch, 'claims'),
    },
  });
  const selected = await stim.logs({ sources: ['agent'], grep: ':wanted$', tail: 6 });
  expect(selected.map((record) => record.msg)).toEqual([
    'first:98:wanted',
    'first:99:wanted',
    'second:96:wanted',
    'second:97:wanted',
    'second:98:wanted',
    'second:99:wanted',
  ]);
  const all = await stim.logs({ sources: ['agent'] });
  expect(all).toHaveLength(24000);
  expect(await stim.logs({ sources: ['agent'], tail: 20 })).toEqual(all.slice(-20));
  expect(await stim.logs({ sources: ['agent'], tail: 0 })).toEqual([]);
  const messages: string[] = [];
  let complete!: () => void;
  const appended = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const stop = await stim.followLogs({ sources: ['agent'], tail: 2 }, (record) => {
    messages.push(String(record.msg));
    if (messages.length === 82) complete();
  });
  const lines = Array.from({ length: 80 }, (_, index) =>
    JSON.stringify({
      version: 1,
      ts: new Date(Date.parse('2026-10-09T13:00:00Z') + index).toISOString(),
      session: 'first',
      kind: 'action.recorded',
      command: 'press',
      summary: `appended:${index}`,
      details: { platform: 'ios' },
    }),
  );
  appendFileSync(join(state, 'sessions', 'first', 'events.ndjson'), lines.join('\n') + '\n');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      appended,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Missing appended agent actions')), 3500);
      }),
    ]);
    expect(messages.slice(2)).toEqual(Array.from({ length: 80 }, (_, index) => `appended:${index}`));
  } finally {
    clearTimeout(timeout);
    stop();
  }
});

test('a progress failure during log backfill rejects unchanged and stops the live subscription', async () => {
  const { root, home, directory } = fixture('follow-progress-error');
  const path = join(directory, 'build.ndjson');
  writeFileSync(path, JSON.stringify({ ts: 1, level: 'info', src: 'build', msg: 'backfill' }) + '\n');
  const failure = new Error('log progress consumer failed');
  const sync = vi.spyOn(hostedLogs, 'syncHostedLogs').mockImplementation(async (_root, context) => {
    context?.output('stderr', 'hosted read unavailable\n');
    return false;
  });
  const received: string[] = [];
  const stim = createStim({
    projectRoot: root,
    home,
    onProgress: () => {
      throw failure;
    },
  });
  try {
    await expect(stim.logs({ sources: ['build'], tail: 1 })).rejects.toBe(failure);
    await expect(
      stim.followLogs({ sources: ['build'], tail: 1 }, (record) => received.push(String(record.msg))),
    ).rejects.toBe(failure);
    appendFileSync(path, JSON.stringify({ ts: 2, level: 'info', src: 'build', msg: 'live' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(received).toEqual(['backfill']);
  } finally {
    sync.mockRestore();
  }
});

test.each(['complete', 'abort'])(
  'batched backfill waits for its consumer and preserves appended records (%s)',
  async (mode) => {
    const { root, home, directory } = fixture('batched-follow');
    const path = join(directory, 'build.ndjson');
    const records = Array.from({ length: 6001 }, (_, index) => ({ ts: index + 1, src: 'build', msg: `old-${index}` }));
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const controller = new AbortController();
    let resume = () => {};
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let began = () => {};
    const firstBatch = new Promise<void>((resolve) => {
      began = resolve;
    });
    let appended = () => {};
    const live = new Promise<void>((resolve) => {
      appended = resolve;
    });
    const backfill: unknown[] = [];
    const received: unknown[] = [];
    const setup = createStim({ projectRoot: root, home }).followLogs(
      { sources: ['build'], signal: controller.signal },
      (record) => {
        received.push(record);
        appended();
      },
      async (batch) => {
        expect(batch.length).toBeLessThanOrEqual(500);
        backfill.push(...batch);
        if (backfill.length === batch.length) {
          began();
          await paused;
        }
      },
    );
    try {
      await firstBatch;
      expect(backfill).toHaveLength(500);
      const next = { ts: 6002, src: 'build', msg: 'during backfill' };
      appendFileSync(path, JSON.stringify(next) + '\n');
      if (mode === 'abort') controller.abort();
      resume();
      const outcome = await setup.then(
        () => 'complete',
        (error) => (error instanceof StimError ? error.code : String(error)),
      );
      expect(outcome).toBe(mode === 'abort' ? 'STIM_CANCELLED' : 'complete');
      if (mode === 'complete') await live;
      expect(backfill).toEqual(mode === 'abort' ? records.slice(0, 500) : records);
      expect(received).toEqual(mode === 'abort' ? [] : [next]);
    } finally {
      resume();
      controller.abort();
      (await setup.catch(() => null))?.();
    }
  },
);
