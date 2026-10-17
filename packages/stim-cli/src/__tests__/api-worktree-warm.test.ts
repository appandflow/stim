import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStim } from '../api.ts';
import { upsertProject } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { warmClaimPath } from '../engine/warm-claim.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-api-warm-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'caller-home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fixture(name: string) {
  const directory = join(scratch, name);
  const root = join(directory, 'source');
  const linked = join(directory, 'linked');
  const home = join(directory, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home);
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, STIM_HOME: home };
  const git = (args: string[]) => getExecutor().runFileAsync('git', args, { cwd: root, env, timeoutMs: 15_000 });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await git(['config', 'commit.gpgsign', 'false']);
  const carried = `carried-${name}`;
  writeFileSync(join(root, '.gitignore'), `${carried}/\n`);
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"react-native":"0.88.0"}}');
  await git(['add', '.gitignore', 'package.json']);
  await git(['commit', '-qm', 'initial']);
  await git(['worktree', 'add', '--detach', linked, 'HEAD']);
  mkdirSync(join(root, carried));
  writeFileSync(join(root, carried, 'value'), name);
  const output: string[] = [];
  return { root, linked, home, env, carried, output };
}

test('concurrent warm clients copy real ignored files with isolated homes and progress', async () => {
  const first = await fixture('first');
  const second = await fixture('second');
  const cwd = process.cwd();
  const env = { ...process.env };
  const exit = process.exitCode;
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  try {
    const results = await Promise.all(
      [first, second].map((item) =>
        createStim({
          projectRoot: item.linked,
          home: item.home,
          env: item.env,
          onProgress: ({ stream, message }) => {
            expect(stream).toBe('stderr');
            item.output.push(message);
          },
        }).warmWorktree(),
      ),
    );
    expect(results).toEqual([expect.objectContaining({ exitCode: 0 }), expect.objectContaining({ exitCode: 0 })]);
    for (const [index, item] of [first, second].entries()) {
      expect(readFileSync(join(item.linked, item.carried, 'value'), 'utf8')).toBe(index === 0 ? 'first' : 'second');
      expect(JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8')).projects[item.linked]).toBeDefined();
      expect(item.output.join('')).toContain(item.carried);
      expect(item.output.join('')).not.toContain(index === 0 ? second.root : first.root);
    }
    expect(existsSync(join(scratch, 'caller-home'))).toBe(false);
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(env);
    expect(process.exitCode).toBe(exit);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}, 30_000);

test('an already cancelled warm leaves the destination untouched', async () => {
  const item = await fixture('cancelled');
  const client = createStim({ projectRoot: item.linked, home: item.home, env: item.env });
  await expect(client.warmWorktree({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  expect(existsSync(join(item.linked, item.carried))).toBe(false);
}, 30_000);

test('a slow warm can outlast the report budget before its copy completes', async () => {
  const item = await fixture('slow');
  const executor = getExecutor();
  const runFile = executor.runFileAsync.bind(executor);
  let copied: AbortSignal | undefined;
  let started = () => {};
  const copying = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const copy = vi.spyOn(executor, 'runFileAsync').mockImplementation(async (file, args, options) => {
    if (file === 'cp') {
      copied = options.signal;
      started();
      await gate;
    }
    return runFile(file, args, options);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const pending = createStim({ projectRoot: item.linked, home: item.home, env: item.env }).warmWorktree();
  try {
    await Promise.race([copying, pending]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(copied?.aborted).toBe(false);
    release();
    expect(await pending).toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(item.linked, item.carried, 'value'), 'utf8')).toBe('slow');
  } finally {
    release();
    await pending.catch(() => {});
    copy.mockRestore();
    vi.useRealTimers();
  }
}, 30_000);

test('warming waits for the target writer and cancels without copying past it', async () => {
  const item = await fixture('writer');
  vi.stubEnv('STIM_HOME', item.home);
  const held = tryAcquireClaim({ root: warmClaimPath(item.linked), mode: 'exclusive', label: 'target writer' });
  assert(held.acquired);
  const controller = new AbortController();
  let admitted = () => {};
  const admission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  let observed = () => {};
  const waiting = new Promise<void>((resolve) => {
    observed = resolve;
  });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
  const pending = createStim({
    projectRoot: item.linked,
    home: item.home,
    env: item.env,
    onProgress: ({ message }) => {
      if (message.includes('waiting ')) observed();
    },
  }).warmWorktree({ signal: controller.signal, beforeWarm: admitted });
  try {
    await Promise.race([admission, pending]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(31_000);
    await Promise.race([waiting, pending]);
    expect(existsSync(join(item.linked, item.carried))).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  } finally {
    controller.abort();
    await pending.catch(() => {});
    releaseClaim(held.acquired);
    vi.useRealTimers();
  }
}, 30_000);

test('an inferred app is admitted before warming registers or copies its worktree', async () => {
  const item = await fixture('inferred');
  for (const checkout of [item.root, item.linked]) {
    writeFileSync(join(checkout, 'package.json'), '{"private":true}');
    mkdirSync(join(checkout, 'apps/mobile'), { recursive: true });
    writeFileSync(join(checkout, 'apps/mobile/package.json'), '{"dependencies":{"react-native":"0.88.0"}}');
  }
  vi.stubEnv('STIM_HOME', item.home);
  upsertProject(join(item.root, 'apps/mobile'), {});
  const app = join(item.linked, 'apps/mobile');
  const pending = createStim({ projectRoot: item.linked, home: item.home, env: item.env }).warmWorktree({
    beforeWarm: (workspace) => {
      if (workspace === app) throw new Error('app already has an active action');
    },
  });
  await expect(pending).rejects.toThrow('app already has an active action');
  expect(JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8')).projects[app]).toBeUndefined();
  expect(existsSync(join(item.linked, item.carried))).toBe(false);
}, 30_000);

test('cancelling an active copy drains its child, removes partial output and releases both claims', async () => {
  const item = await fixture('active');
  const executor = getExecutor();
  const runFile = executor.runFileAsync.bind(executor);
  const controller = new AbortController();
  let copied = 0;
  let started = () => {};
  const copying = new Promise<void>((resolve) => {
    started = resolve;
  });
  const copy = vi.spyOn(executor, 'runFileAsync').mockImplementation(async (file, args, options) => {
    if (file !== 'cp') return runFile(file, args, options);
    copied++;
    const script =
      'const fs = require("node:fs"); fs.mkdirSync(process.argv[1], {recursive:true}); ' +
      'fs.writeFileSync(process.argv[1] + "/partial", "partial"); console.log("ready"); setInterval(() => {}, 1000);';
    const destination = args[2];
    assert(destination);
    return runFile(process.execPath, ['-e', script, destination], {
      ...options,
      onSpawn: (child) => {
        options.onSpawn?.(child);
        child.stdout?.on('data', () => started());
      },
    });
  });
  const pending = createStim({ projectRoot: item.linked, home: item.home, env: item.env }).warmWorktree({
    signal: controller.signal,
  });
  try {
    await Promise.race([copying, pending]);
    expect(readFileSync(join(item.linked, item.carried, 'partial'), 'utf8')).toBe('partial');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(copied).toBe(1);
    expect(existsSync(join(item.linked, item.carried))).toBe(false);
    vi.stubEnv('STIM_HOME', item.home);
    expect(readClaimSet(warmClaimPath(item.root)).live).toEqual([]);
    expect(readClaimSet(warmClaimPath(item.linked)).live).toEqual([]);
  } finally {
    controller.abort();
    await pending.catch(() => {});
    copy.mockRestore();
  }
}, 30_000);
