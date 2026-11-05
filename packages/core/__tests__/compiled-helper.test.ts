import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { vi } from 'vitest';
import { compiledHelper } from '../compiled-helper.ts';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const older = 'stim-frames-1111111111111111';
const previous = 'stim-frames-2222222222222222';

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
});
