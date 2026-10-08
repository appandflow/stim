import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
