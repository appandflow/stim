import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStim, StimError } from '../api.ts';
import { getExecutor } from '../exec.ts';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-api-remove-')));
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
  const output: string[] = [];
  const git = (args: string[]) => getExecutor().runFileAsync('git', args, { cwd: root, env, timeoutMs: 15_000 });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'package.json'), '{"private":true}');
  await git(['add', 'package.json']);
  await git(['commit', '-qm', 'initial']);
  await git(['worktree', 'add', '--detach', linked, 'HEAD']);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ version: 2, projects: { [root]: { metroPort: null }, [linked]: { metroPort: null } } }),
  );
  return { root, linked, home, env, git, output };
}

test('concurrent clients remove real worktrees using their own cwd, home and output', async () => {
  const first = await fixture('first');
  const second = await fixture('second');
  const cwd = process.cwd();
  const env = { ...process.env };
  const exit = process.exitCode;
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  try {
    const results = await Promise.allSettled(
      [first, second].map((item, index) =>
        createStim({
          projectRoot: index === 0 ? item.root : item.linked,
          home: item.home,
          env: item.env,
          onProgress: ({ stream, message }) => {
            expect(stream).toBe('stderr');
            item.output.push(message);
          },
        }).removeWorktree(index === 0 ? { target: '../linked' } : {}),
      ),
    );
    expect(results).toEqual([
      { status: 'fulfilled', value: { removed: true, exitCode: 0 } },
      { status: 'fulfilled', value: { removed: true, exitCode: 0 } },
    ]);
    for (const [index, item] of [first, second].entries()) {
      expect(existsSync(item.linked)).toBe(false);
      expect(existsSync(join(item.root, 'package.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8')).projects).toEqual({
        [item.root]: { metroPort: null },
      });
      expect(item.output.join('')).toContain(item.linked);
      expect(item.output.join('')).not.toContain(index === 0 ? second.linked : first.linked);
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

test('a refusal preserves dirty files, while explicit force removes the worktree', async () => {
  const item = await fixture('dirty');
  const marker = join(item.linked, 'unsaved.txt');
  writeFileSync(marker, 'unsaved');
  const client = createStim({ projectRoot: item.root, home: item.home, env: item.env });
  expect(await client.removeWorktree({ target: item.linked })).toEqual({ removed: false, exitCode: 1 });
  expect(readFileSync(marker, 'utf8')).toBe('unsaved');
  expect(await client.removeWorktree({ target: item.linked, force: true })).toEqual({ removed: true, exitCode: 0 });
  expect(existsSync(item.linked)).toBe(false);
}, 30_000);

test.skipIf(process.platform === 'win32')(
  'an API removal deletes the ignored directories it moved to the trash before it resolves',
  async () => {
    const item = await fixture('trash');
    writeFileSync(join(item.root, '.git', 'info', 'exclude'), 'node_modules/\n');
    for (let index = 0; index < 200; index++) {
      mkdirSync(join(item.linked, 'node_modules', `pkg-${index}`), { recursive: true });
      writeFileSync(join(item.linked, 'node_modules', `pkg-${index}`, 'index.js'), 'module.exports = 1;');
    }
    const client = createStim({ projectRoot: item.root, home: item.home, env: item.env });

    expect(await client.removeWorktree({ target: item.linked })).toEqual({ removed: true, exitCode: 0 });

    expect(existsSync(item.linked)).toBe(false);
    expect(readdirSync(join(item.home, 'trash'))).toEqual([]);
  },
  30_000,
);

test.skipIf(process.platform === 'win32')(
  'an API removal run from the worktree it removes also empties the trash',
  async () => {
    const item = await fixture('trash-self');
    writeFileSync(join(item.root, '.git', 'info', 'exclude'), 'node_modules/\n');
    mkdirSync(join(item.linked, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(item.linked, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
    const execSpy = vi.spyOn(getExecutor(), 'runFileAsync');
    const client = createStim({ projectRoot: item.linked, home: item.home, env: item.env });

    expect(await client.removeWorktree()).toEqual({ removed: true, exitCode: 0 });

    expect(existsSync(item.linked)).toBe(false);
    expect(readdirSync(join(item.home, 'trash'))).toEqual([]);
    expect(execSpy.mock.calls.filter(([file]) => file === 'rm').map(([, , options]) => options?.cwd)).toEqual([
      join(item.home, 'trash'),
    ]);
    execSpy.mockRestore();
  },
  30_000,
);

test('source checkout cleanup succeeds without deleting the checkout or another workspace record', async () => {
  const item = await fixture('source');
  const client = createStim({ projectRoot: item.root, home: item.home, env: item.env });
  expect(await client.removeWorktree()).toEqual({ removed: false, exitCode: 0 });
  expect(existsSync(join(item.root, '.git'))).toBe(true);
  expect(existsSync(item.linked)).toBe(true);
  expect(JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8')).projects).toEqual({
    [item.linked]: { metroPort: null },
  });
}, 30_000);

test('invalid requests and an already cancelled request leave the target untouched', async () => {
  const item = await fixture('invalid');
  const client = createStim({ projectRoot: item.root, home: item.home, env: item.env });
  await expect(client.removeWorktree({ target: '' })).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
  await expect(Reflect.apply(client.removeWorktree, client, [{ force: 'yes' }])).rejects.toMatchObject({
    code: 'STIM_BAD_ARG',
  });
  await expect(client.removeWorktree({ target: item.linked, signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: 'STIM_CANCELLED',
  });
  expect(existsSync(join(item.linked, 'package.json'))).toBe(true);
}, 30_000);

test('cancellation drains a blocked Git safety check before rejecting and preserves the target', async () => {
  const item = await fixture('cancel');
  const controller = new AbortController();
  const executor = getExecutor();
  const run = executor.runFileAsync.bind(executor);
  let child: ChildProcess | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) =>
    file === 'git' && args.includes('status')
      ? run(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
          ...options,
          onSpawn: (spawned) => {
            options.onSpawn?.(spawned);
            child = spawned;
            spawned.stdout?.once('data', started);
          },
        })
      : run(file, args, options),
  );
  const pending = createStim({ projectRoot: item.linked, home: item.home, env: item.env }).removeWorktree({
    signal: controller.signal,
  });
  try {
    await Promise.race([
      ready,
      pending.then(() => {
        throw new Error('Removal returned before its Git safety check started.');
      }),
    ]);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(child && (child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(existsSync(join(item.linked, 'package.json'))).toBe(true);
  } finally {
    controller.abort();
    await pending.catch(() => {});
    probe.mockRestore();
  }
}, 30_000);

test('branch cleanup failure preserves a successful deletion and can be retried from the source client', async () => {
  const item = await fixture('partial');
  await item.git(['-C', item.linked, 'switch', '-c', 'owned']);
  writeFileSync(
    join(item.home, 'config.json'),
    JSON.stringify({
      version: 2,
      projects: {
        [item.linked]: {
          metroPort: null,
          worktreeBranchOwned: true,
          worktreeBranch: 'owned',
          worktreeMainRoot: item.root,
        },
      },
    }),
  );
  const lock = join(item.root, '.git', 'refs', 'heads', 'owned.lock');
  writeFileSync(lock, 'held');
  const client = createStim({ projectRoot: item.root, home: item.home, env: item.env });
  expect(await client.removeWorktree({ target: item.linked })).toEqual({ removed: true, exitCode: 1 });
  expect(existsSync(item.linked)).toBe(false);
  expect(await item.git(['branch', '--list', 'owned'])).toBe('owned');
  await unlink(lock);
  expect(await client.removeWorktree({ target: item.linked })).toEqual({ removed: false, exitCode: 0 });
  expect(await item.git(['branch', '--list', 'owned'])).toBe('');
  expect(JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8')).projects).toEqual({});
}, 30_000);

test('a thrown progress callback cancels a refusal and is propagated unchanged', async () => {
  const item = await fixture('callback');
  writeFileSync(join(item.linked, 'unsaved.txt'), 'keep');
  const failure = new Error('progress failed');
  const client = createStim({
    projectRoot: item.linked,
    home: item.home,
    env: item.env,
    onProgress: () => {
      throw failure;
    },
  });
  await expect(client.removeWorktree()).rejects.toBe(failure);
  expect(readFileSync(join(item.linked, 'unsaved.txt'), 'utf8')).toBe('keep');
}, 30_000);

test.each(['alias', 'linked subfolder', 'source project subfolder', 'registered descendant'])(
  'admission covers the resolved cleanup scope for %s before effects',
  async (mode) => {
    const item = await fixture('admission');
    const nested = join(mode === 'source project subfolder' ? item.root : item.linked, 'app');
    const target = join(nested, 'subdir');
    mkdirSync(target, { recursive: true });
    const alias = join(scratch, 'linked-alias');
    symlinkSync(item.linked, alias);
    if (mode === 'source project subfolder' || mode === 'registered descendant') {
      const config = JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8'));
      config.projects[nested] = { metroPort: null };
      writeFileSync(join(item.home, 'config.json'), JSON.stringify(config));
    }
    const expected =
      mode === 'source project subfolder'
        ? [nested]
        : mode === 'registered descendant'
          ? [item.linked, nested]
          : [item.linked];
    const admitted: string[] = [];
    await expect(
      createStim({ projectRoot: item.root, home: item.home, env: item.env }).removeWorktree({
        target: mode === 'alias' || mode === 'registered descendant' ? alias : target,
        beforeRemove: (path) => {
          admitted.push(path);
          if (path === expected.at(-1))
            throw new StimError({ code: 'STIM_ACTION_BUSY', message: 'target already busy' });
        },
      }),
    ).rejects.toMatchObject({ code: 'STIM_ACTION_BUSY', message: 'target already busy' });
    expect(admitted).toEqual(expected);
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8')).projects[item.linked]).toBeDefined();
  },
  30_000,
);
