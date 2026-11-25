import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { removeTree, seal } from '../engine-store/tree.ts';

let temp: string;
let tree: string;

afterEach(() => {
  if (tree && existsSync(tree)) removeTree(tree);
  if (temp) rmSync(temp, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')('sealing and removing a tree preserves symlink target modes', () => {
  temp = mkdtempSync(join(tmpdir(), 'stim-engine-tree-'));
  const root = join(temp, 'engine');
  const scratch = join(root, '.tmp-package');
  const outside = join(temp, 'outside');
  mkdirSync(join(scratch, 'dist'), { recursive: true });
  mkdirSync(join(scratch, 'sub'));
  mkdirSync(join(outside, 'deep'), { recursive: true });
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'stim', version: '1.0.0' }));
  writeFileSync(join(scratch, 'dist', 'cli.mjs'), 'export {};\n');
  writeFileSync(join(outside, 'deep', 'f'), 'outside');
  symlinkSync(relative(join(scratch, 'sub'), outside), join(scratch, 'sub', 'link'));
  const paths = [outside, join(outside, 'deep'), join(outside, 'deep', 'f')];
  const modes = paths.map((path) => statSync(path).mode);
  tree = scratch;
  const build = seal(root, scratch);
  tree = join(root, build);
  expect(paths.map((path) => statSync(path).mode)).toEqual(modes);
  removeTree(tree);
  expect(existsSync(tree)).toBe(false);
  expect(existsSync(outside)).toBe(true);
  expect(paths.map((path) => statSync(path).mode)).toEqual(modes);
});
