import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli/define-op.ts';
import engineOp from '../commands/engine.ts';
import { writeRecord } from '../engine-store/store.ts';
import { removeTree, seal } from '../engine-store/tree.ts';
import { readRunningProcesses, runningFromReason } from '../workspace/running-from.ts';

let temp: string;
let root: string;
let tree: string;

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-engine-uninstall-')));
  root = join(temp, 'engine');
  vi.stubEnv('STIM_ENGINE_ROOT', root);
  vi.stubEnv('STIM_HOME', join(temp, 'home'));
  vi.stubEnv('HOME', temp);
});

afterEach(() => {
  try {
    if (tree && existsSync(tree)) removeTree(tree);
    rmSync(temp, { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

test.skipIf(process.platform === 'win32')('uninstall leaves a build kept by a live process removable', async () => {
  const scratch = join(root, '.tmp-package');
  mkdirSync(join(scratch, 'dist'), { recursive: true });
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'stim', version: '1.0.0' }));
  writeFileSync(join(scratch, 'dist', 'cli.mjs'), 'export {};\n');
  const build = seal(root, scratch);
  tree = join(root, build);
  writeRecord(join(root, 'current.json'), { format: 1, dir: build, version: '1.0.0' });
  const child = spawn(
    process.execPath,
    ['-e', "setInterval(() => {}, 1000); process.stdout.write('ready');", join(tree, 'dist', 'cli.mjs')],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    if (!child.stdout) throw new Error('child stdout is unavailable');
    await once(child.stdout, 'data');
    expect(runningFromReason(tree, readRunningProcesses())).toBe(`process ${child.pid} runs from it`);
    expect(await runCli(engineOp, ['uninstall'], { version: '1.0.0' })).toBe(0);
    expect(existsSync(join(root, 'current.json'))).toBe(false);
    expect(existsSync(tree)).toBe(true);
    expect(() => rmSync(root, { recursive: true })).not.toThrow();
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
});
