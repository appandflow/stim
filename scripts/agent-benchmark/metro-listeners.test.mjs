import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { ownedMetroListeners } from './metro-listeners.mjs';

it.skipIf(process.platform !== 'darwin')(
  'recognizes a real custom-port Metro listener without adopting a sibling server',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-metro-live-'));
    const sibling = join(root, 'other');
    mkdirSync(sibling);
    const children = [];
    try {
      const launch = async (cwd) => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import http from 'node:http'; const s = http.createServer((q,r)=>r.end('packager-status:running')); s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
          ],
          { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        children.push(child);
        const [data] = await once(child.stdout, 'data');
        return { pid: child.pid, port: Number(data.toString().trim()) };
      };
      const owned = await launch(root);
      const foreign = await launch(sibling);
      expect(ownedMetroListeners(root)).toEqual([owned]);
      expect(ownedMetroListeners(sibling)).toEqual([foreign]);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          const closed = once(child, 'close');
          child.kill();
          await closed;
        }),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);

it('discovers custom ports only for the exact canonical worktree and a verified Metro endpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-metro-'));
  try {
    const worktree = join(root, 'app');
    const sibling = join(root, 'app-other');
    const alias = join(root, 'alias');
    mkdirSync(worktree);
    mkdirSync(sibling);
    symlinkSync(worktree, alias);
    const execute = (file, args) => {
      if (args.includes('-Fpn'))
        return 'p100\nn*:18081\nn127.0.0.1:18081\np101\nn*:18082\np102\nn*:18083\np103\nn*:18084\n';
      if (args.includes('cwd')) {
        const pid = args[args.indexOf('-p') + 1];
        if (pid === '103') throw new Error('process exited');
        return `p${pid}\nn${pid === '101' ? sibling : alias}\n`;
      }
      if (file === 'curl') return args.at(-1).includes(':18081/') ? 'packager-status:running' : 'other server';
      throw new Error('unexpected command');
    };
    expect(ownedMetroListeners(worktree, execute)).toEqual([{ pid: 100, port: 18081 }]);
    expect(
      ownedMetroListeners(worktree, () => {
        throw new Error('denied');
      }),
    ).toEqual([]);
    expect(ownedMetroListeners(join(root, 'missing'), execute)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
