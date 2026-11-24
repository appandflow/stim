import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import * as identity from '../process-identity.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceAgentDeviceDir, workspaceDir } from '../workspace/paths.ts';

let tmpHome: string;
let bin: string;
const path = process.env.PATH;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  bin = join(tmpHome, 'bin');
  mkdirSync(bin);
  process.env.PATH = `${bin}${delimiter}${path}`;
});

afterEach(() => {
  process.env.PATH = path;
  delete process.env.STIM_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')(
  'reclaim waits for agent-device to force-stop a daemon that ignores SIGTERM',
  async () => {
    const release = join(bin, 'release');
    const fake = join(bin, 'agent-device');
    writeFileSync(
      fake,
      `#!${process.execPath}
const { existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const { pid } = JSON.parse(readFileSync(join(stateDir, 'daemon.json'), 'utf8'));
process.kill(pid, 'SIGTERM');
while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
process.kill(pid, 'SIGKILL');
rmSync(join(stateDir, 'daemon.json'));
console.log('Daemon stopped (forced).');
`,
    );
    chmodSync(fake, 0o755);
    const daemon = spawn(
      process.execPath,
      ['-e', `process.on('SIGTERM', () => console.log('term')); console.log('ready'); setInterval(() => {}, 1000);`],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const lines: string[] = [];
    const heard = (line: string) =>
      new Promise<void>((resolve) => {
        const check = () => lines.includes(line) && resolve();
        daemon.stdout.on('data', (chunk: Buffer) => {
          lines.push(...chunk.toString().split('\n'));
          check();
        });
        check();
      });
    const exited = once(daemon, 'exit');
    try {
      await heard('ready');
      upsertProject('/proj', { metroPort: 8082 });
      ensureWorkspaceStorage('/proj');
      const stateDir = workspaceAgentDeviceDir('/proj');
      mkdirSync(stateDir);
      writeFileSync(
        join(stateDir, 'daemon.json'),
        JSON.stringify({ pid: daemon.pid, processStartTime: '2026-11-01T05:50:03Z' }),
      );
      vi.spyOn(identity, 'inspectProcessStart').mockReturnValue({
        status: 'running',
        startedAtMs: Date.parse('2026-11-01T05:50:03Z'),
      });

      const reclaimed = reclaimProject('/proj', { deleteOwnedDevices: false });
      await heard('term');
      await vi.advanceTimersByTimeAsync(30_000);
      writeFileSync(release, '');
      const result = await reclaimed;

      expect(result.failedWorkspaceDirs).toEqual([]);
      expect(existsSync(workspaceDir('/proj'))).toBe(false);
      await exited;
    } finally {
      daemon.kill('SIGKILL');
    }
  },
);
