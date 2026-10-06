import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { vi } from 'vitest';
import { compiledHelper, pruneCompiledHelpers, selectHelpersToPrune } from '../compiled-helper.ts';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const current = 'stim-frames-0000000000000000';
const older = 'stim-frames-1111111111111111';
const previous = 'stim-frames-2222222222222222';
const oldest = 'stim-frames-3333333333333333';

test('keeps the current build even when it is oldest and retains the newest previous build by mtime', () => {
  expect(
    selectHelpersToPrune(
      [
        { name: current, mtimeMs: 0 },
        { name: oldest, mtimeMs: 1 },
        { name: previous, mtimeMs: 3 },
        { name: older, mtimeMs: 2 },
      ],
      current,
      'stim-frames',
      new Set(),
    ),
  ).toEqual([older, oldest]);
});

test('breaks equal mtimes by name regardless of entry order', () => {
  expect(
    selectHelpersToPrune(
      [
        { name: current, mtimeMs: 0 },
        { name: previous, mtimeMs: 1 },
        { name: older, mtimeMs: 1 },
      ],
      current,
      'stim-frames',
      new Set(),
    ),
  ).toEqual([previous]);
});

test('selects only exact helper hashes and leaves other prefixes and temporary files untouched', () => {
  const unrelated = [
    'sim-fold-1111111111111111',
    'stim-frames-x-1111111111111111',
    'stim-frames-x',
    `${oldest}.tmp-123-abcdef`,
    'stim-frames-AAAAAAAAAAAAAAAA',
    'stim-frames-111111111111111',
    'stim-frames-11111111111111111',
    `${oldest}\n`,
  ];
  expect(
    selectHelpersToPrune(
      [
        ...unrelated.map((name) => ({ name, mtimeMs: 100 })),
        { name: current, mtimeMs: 0 },
        { name: previous, mtimeMs: 2 },
        { name: older, mtimeMs: 1 },
      ],
      current,
      'stim-frames',
      new Set(),
    ),
  ).toEqual([older]);
});

test('keeps a running older build in addition to the current and newest previous builds', () => {
  expect(
    selectHelpersToPrune(
      [
        { name: current, mtimeMs: 4 },
        { name: previous, mtimeMs: 3 },
        { name: older, mtimeMs: 2 },
        { name: oldest, mtimeMs: 1 },
      ],
      current,
      'stim-frames',
      new Set([oldest]),
    ),
  ).toEqual([older]);
});

describe('pruning on disk', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-compiled-helper-')));
    dir = join(root, 'helpers');
    mkdirSync(dir);
  });

  afterEach(() => {
    vi.resetAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function build(name: string, mtime: number): void {
    const path = join(dir, name);
    writeFileSync(path, name);
    utimesSync(path, mtime, mtime);
  }

  test.each([false, true])(
    'prunes regular files while protecting a canonical running path (running: %s)',
    (running) => {
      build(current, 1);
      build(previous, 4);
      build(older, 3);
      build(oldest, 2);
      const untouched = ['sim-fold-1111111111111111', `${older}.tmp-123-abcd`];
      for (const name of untouched) build(name, 10);
      const directory = 'stim-frames-4444444444444444';
      mkdirSync(join(dir, directory));
      const link = 'stim-frames-5555555555555555';
      symlinkSync(join(dir, oldest), join(dir, link));
      const alias = join(root, 'alias');
      symlinkSync(dir, alias, 'junction');
      const executableAlias = join(root, 'executable-alias');
      symlinkSync(dir, executableAlias, 'junction');

      pruneCompiledHelpers(
        alias,
        current,
        'stim-frames',
        () => new Set(running ? [join(executableAlias, oldest)] : []),
      );

      expect(readdirSync(dir).toSorted()).toEqual(
        [...untouched, current, previous, directory, link, ...(running ? [oldest] : [])].toSorted(),
      );
    },
  );

  test('does not inspect processes with two or fewer matching regular files', () => {
    build(current, 1);
    build(older, 2);
    build(`${previous}.tmp-123-abcd`, 3);
    build('sim-fold-1111111111111111', 4);
    mkdirSync(join(dir, previous));
    const paths = vi.fn<() => ReadonlySet<string>>(() => new Set());

    pruneCompiledHelpers(dir, current, 'stim-frames', paths);

    expect(paths).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, older), 'utf8')).toBe(older);
  });

  test.each([
    { status: 1, stdout: '/some/executable\n' },
    { status: 0, stdout: Buffer.from('unreadable') },
    { status: 0, stdout: '' },
  ])('leaves all builds in place when ps fails or output is unavailable (%j)', ({ status, stdout }) => {
    build(current, 1);
    build(previous, 3);
    build(older, 2);
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [],
      stdout,
      stderr: '',
      status,
      signal: null,
    });

    pruneCompiledHelpers(dir, current, 'stim-frames');

    expect(readdirSync(dir).toSorted()).toEqual([current, older, previous].toSorted());
  });

  test('swallows process inspection errors and leaves all builds in place', () => {
    build(current, 1);
    build(previous, 3);
    build(older, 2);

    pruneCompiledHelpers(dir, current, 'stim-frames', () => {
      throw new Error('process inspection failed');
    });

    expect(readdirSync(dir).toSorted()).toEqual([current, older, previous].toSorted());
  });

  test('compiledHelper prunes after a fresh build and on the first cache hit of a process', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [],
      stdout: `${process.execPath}\n`,
      stderr: '',
      status: 0,
      signal: null,
    });
    const compile = vi.fn<(output: string) => Promise<void>>(async (output) => {
      writeFileSync(output, 'compiled bytes');
    });
    const options = { dir, name: 'stim-frames', inputs: [], version: 'v1', compile };
    build(older, 1);
    build(previous, 2);

    const helper = await compiledHelper(options);

    expect(readFileSync(helper, 'utf8')).toBe('compiled bytes');
    expect(readdirSync(dir).toSorted()).toEqual([basename(helper), previous].toSorted());

    build(older, 1);
    await compiledHelper(options);
    expect(readdirSync(dir)).toContain(older);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  test('keeps builds modified within the last ten minutes', () => {
    build(current, 1);
    build(oldest, 3);
    writeFileSync(join(dir, older), 'fresh');
    writeFileSync(join(dir, previous), 'fresh');

    pruneCompiledHelpers(dir, current, 'stim-frames', () => new Set());

    expect(readdirSync(dir).toSorted()).toEqual([current, older, previous].toSorted());
  });
});
