import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { diskUsageCacheFile, gcMarkFile, GC_MARK_VERSION } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { formatBytes } from '../fs-util.ts';
import { listOp, worktreeListPayload } from '../commands/worktree-list.ts';
import { upsertProject } from '../workspace/config.ts';

let home: string;
let repository: string;
let roots: [string, string, string];
const GIB = 1024 ** 3;
const savedAt = '2026-01-01T00:00:00.000Z';
function save(file: string, value: object) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-list-')));
  vi.stubEnv('STIM_HOME', join(home, 'state'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  repository = join(home, 'repo');
  mkdirSync(repository);
  const git = (args: string[]) => getExecutor().runFile('git', args, { cwd: repository, timeoutMs: 5000 });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(repository, '.gitignore'), 'node_modules\n');
  git(['add', '.gitignore']);
  git([
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'initial',
  ]);
  roots = [
    join(repository, '.worktrees', 'dirty'),
    join(repository, '.worktrees', 'large'),
    join(repository, '.worktrees', 'unknown'),
  ];
  for (const [index, root] of roots.entries()) {
    git(['worktree', 'add', '-q', '-b', `branch-${index}`, root]);
    if (index !== 1) upsertProject(root, { metroPort: null });
    save(diskUsageCacheFile(root), {
      path: root,
      bytes: index === 1 ? 4 * GIB : index === 2 ? 3 * GIB : 100,
      ...(index === 2 ? {} : { privateBytes: index === 1 ? 2 * GIB : 100 }),
      measuredAt: new Date().toISOString(),
    });
  }
  writeFileSync(join(roots[0], 'dirty.txt'), 'changed');
  for (const index of [1, 2] as const) {
    const path = join(roots[index], 'node_modules');
    mkdirSync(path);
  }
  const gitDir = readFileSync(join(roots[1], '.git'), 'utf8').trim().slice(8);
  const old = new Date(Date.now() - 31 * 86_400_000);
  for (const name of ['index', 'HEAD', 'logs/HEAD']) utimesSync(join(gitDir, name), old, old);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  rmSync(home, { recursive: true, force: true });
});

async function run(options: { all?: true; json?: true }) {
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => {
    output.push(String(value));
  });
  vi.spyOn(process, 'cwd').mockReturnValue(repository);
  if (!listOp.run) throw new Error('Missing list runner');
  await listOp.run({ options, args: [], parent: {}, version: 'test' });
  return output;
}

test('plain listing sorts real sizes, marks age and size, and reports unknown private bytes', async () => {
  const output = await run({});
  expect(output).toHaveLength(4);
  expect(output[0]).toContain('.worktrees/large');
  expect(output[0]).toContain(' | large');
  expect(output[0]).toContain(' | old');
  expect(output[0]).toContain('idle 31d');
  expect(output[0]).toContain('kept: not known to this Stim home:');
  expect(output.join('\n')).not.toContain('kept: kept:');
  expect(output[1]).toContain('kept: dirty:');
  expect(output[2]).toContain('real unknown');
  expect(output[3]).toContain('3 worktrees;');
  expect(output[3]).toContain('1 without a known real size');
  expect(output[3]).toContain(`${formatBytes(2 * GIB + 100)} real`);
  expect(output[3]).toContain(`dirty: 1, ${formatBytes(100)}`);
});

test('JSON is one payload and splits kept totals by gc reason', async () => {
  const output = await run({ json: true });
  expect(output).toHaveLength(1);
  const payload = JSON.parse(output[0] ?? '');
  expect(payload.scope).toBe('repository');
  expect(payload.repositories[0].checkedAt).toBe(payload.repositories[0].worktrees[0].checkedAt);
  expect(payload.repositories[0].oldestCheckedAt).toBe(payload.repositories[0].checkedAt);
  expect(payload.total).toMatchObject({ count: 3, realBytes: 2 * GIB + 100, unmeasured: 1, unchecked: 0 });
  expect(payload.total.kept).toContainEqual(expect.objectContaining({ reason: 'dirty', count: 1, realBytes: 100 }));
  expect(Object.keys(payload.repositories[0].worktrees[0]).toSorted()).toEqual(
    [
      'path',
      'branch',
      'idleDays',
      'realBytes',
      'apparentBytes',
      'measuredAt',
      'willRemove',
      'reason',
      'detail',
      'checkedAt',
      'old',
      'large',
    ].toSorted(),
  );
});

test('machine listing uses saved observations and leaves unobserved worktrees unchecked', async () => {
  const git = getExecutor();
  git.runFile('git', ['worktree', 'remove', '--force', roots[2]], { cwd: repository, timeoutMs: 5000 });
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubEnv('STIM_DAEMON', 'off');
  const checkedAt = new Date(now - 3 * 3_600_000).toISOString();
  const mark = {
    v: GC_MARK_VERSION,
    root: roots[0],
    device: 1,
    markedAt: savedAt,
    lastActivityAt: null,
    candidates: [],
    worktree: {
      markedAt: checkedAt,
      source: repository,
      head: null,
      keys: [],
      clean: false,
      pushed: null,
      finished: null,
      emptyBranch: null,
      activity: null,
      lastUsedAt: null,
      keep: { code: 'dirty', reason: 'kept: saved dirty verdict', eligibleAt: null },
    },
  };
  save(gcMarkFile(roots[0]), mark);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const output = await run({ all: true, json: true });
  const payload = JSON.parse(output[0] ?? '');
  expect(payload.scope).toBe('machine');
  expect(payload.daemonMode).toBe('off');
  expect(payload.repositories[0]).toMatchObject({ checkedAt, oldestCheckedAt: checkedAt });
  expect(error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('Automatic maintenance is off on this machine'),
  );
  expect(payload.total.unchecked).toBe(1);
  expect(payload.repositories[0].worktrees).toContainEqual(
    expect.objectContaining({ path: roots[0], detail: 'saved dirty verdict', checkedAt, willRemove: false }),
  );
  expect(payload.repositories[0].worktrees).toContainEqual(
    expect.objectContaining({ path: roots[1], willRemove: null }),
  );
  const saved = await worktreeListPayload([repository]);
  expect(saved.total.unchecked).toBe(1);
  const plain = await run({ all: true });
  expect(plain[0]).toContain('checked 3h ago');
  expect(plain.join('\n')).toContain('kept: saved dirty verdict');
  expect(plain.join('\n')).not.toContain('kept: kept:');
  save(gcMarkFile(roots[1]), {
    ...mark,
    root: roots[1],
    worktree: { ...mark.worktree, markedAt: new Date(now - 4 * 86_400_000).toISOString() },
  });
  const mixed = await run({ all: true });
  expect(mixed[0]).toContain('checked 3h ago, oldest 96h ago');
  rmSync(gcMarkFile(roots[0]));
  rmSync(gcMarkFile(roots[1]));
  const unchecked = await run({ all: true });
  expect(unchecked[0]).toContain('maintenance worktree check has not run');
  expect(unchecked[0]).toContain('run stim worktree list in this repository for current verdicts');
  const unknown = JSON.parse((await run({ all: true, json: true }))[0] ?? '');
  expect(unknown.repositories[0]).toMatchObject({ checkedAt: null, oldestCheckedAt: null });
});
