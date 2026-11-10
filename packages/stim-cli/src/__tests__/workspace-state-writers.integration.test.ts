import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceDir, workspaceStateFile } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

let tmpHome: string;
let root: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe('state.json concurrent writers (Contract 2 lock)', () => {
  test('4+ processes writing different keys never lose an update', async () => {
    const script = join(tmpHome, 'state-writer.mjs');
    const runUrl = new URL('../workspace/workspace-state.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `const { writeWorkspaceState } = await import(${JSON.stringify(runUrl)});`,
        'const root = process.argv[2];',
        'const key = process.argv[3];',
        "process.on('message', () => {",
        '  writeWorkspaceState(root, { [key]: { pid: process.pid } });',
        "  process.send('done');",
        '});',
        "process.send('ready');",
      ].join('\n'),
    );

    const keys = [
      'supervisor',
      'lastBuild',
      'collectorsIos',
      'collectorsAndroid',
      'extra',
      'sixth',
      'seventh',
      'eighth',
    ];
    const children = keys.map((key) =>
      fork(script, [root, key], {
        env: { ...process.env, STIM_HOME: tmpHome },
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
    );
    function nextWrite(child: ChildProcess): Promise<void> {
      return new Promise((resolve, reject) => {
        const detach = () => {
          child.off('message', received);
          child.off('error', failed);
          child.off('exit', exited);
        };
        const received = () => {
          detach();
          resolve();
        };
        const failed = (error: Error) => {
          detach();
          reject(error);
        };
        const exited = (code: number | null) => failed(new Error(`State writer exited with ${code}`));
        child.once('message', received);
        child.once('error', failed);
        child.once('exit', exited);
      });
    }
    try {
      await Promise.all(children.map(nextWrite));
      for (let round = 0; round < 8; round++) {
        mkdirSync(workspaceDir(root), { recursive: true });
        writeFileSync(workspaceStateFile(root), '{}\n');
        const written = children.map(nextWrite);
        for (const child of children) child.send('write');
        await Promise.all(written);
        const state = readWorkspaceState(root);
        for (const key of keys) expect(state && state[key]).toBeTruthy();
      }
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }),
      );
    }
  }, 15_000);
});
