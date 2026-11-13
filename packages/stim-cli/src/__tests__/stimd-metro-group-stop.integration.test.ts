import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processGroupAlive } from '@stim-cli/core/ownership-claim';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { stopProcessGroup } from '../stimd/metro/group-stop.ts';

let dir: string;
const leaders: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-group-stop-'));
});

afterEach(() => {
  for (const leader of leaders.splice(0)) {
    if (leader.pid && processGroupAlive(leader.pid)) {
      try {
        process.kill(-leader.pid, 'SIGKILL');
      } catch {}
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A group leader that installs its SIGTERM handler, then spawns one member and reports the member's pid on stdout. The
 * member runs `member` after writing a ready marker, so a test starts only once both handlers are in place; a fixture
 * that dies on SIGTERM before that would otherwise look like a stop that ended at once.
 */
async function startGroup(
  leaderOnTerm: string,
  member: string,
): Promise<{ pid: number; processToken: string; member: number }> {
  const ready = join(dir, `ready-${leaders.length}`);
  const memberScript = `${member.replace('READY', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1')`)}`;
  const script = `const { spawn } = require('node:child_process');
${leaderOnTerm}
const member = spawn(process.execPath, ['-e', ${JSON.stringify(memberScript)}], { stdio: 'ignore' });
console.log(member.pid);
setInterval(() => {}, 1000);`;
  const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  leaders.push(leader);
  const first = await new Promise<string>((resolve) => leader.stdout?.once('data', (chunk) => resolve(String(chunk))));
  await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
  const pid = leader.pid;
  const processToken = pid === undefined ? null : captureProcessToken(pid);
  if (!pid || !processToken) throw new Error('fixture leader identity unavailable');
  return { pid, processToken, member: Number(first.trim()) };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('stopping a dev server process group', () => {
  test('a leader that already exited leaves its lingering member time to drain, and nothing is signalled', async () => {
    const group = await startGroup('', 'READY; setTimeout(() => {}, 1500)');
    process.kill(group.pid, 'SIGKILL');
    await vi.waitFor(() => expect(inspectProcessIdentity(group)).toBe('gone'), { timeout: 5000 });
    expect(processGroupAlive(group.pid)).toBe(true);
    await stopProcessGroup(group, { termMs: 5000 });
    expect(processGroupAlive(group.pid)).toBe(false);
  }, 20_000);

  test('a member that ignores SIGTERM is killed by its own pid once the grace period ends', async () => {
    const group = await startGroup(
      "process.on('SIGTERM', () => process.exit(0));",
      "process.on('SIGTERM', () => {}); READY; setInterval(() => {}, 1000)",
    );
    const started = Date.now();
    const stopping = stopProcessGroup(group, { termMs: 800 });
    await new Promise((done) => setTimeout(done, 400));
    expect(alive(group.member)).toBe(true);
    expect(processGroupAlive(group.pid)).toBe(true);
    await stopping;
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(processGroupAlive(group.pid)).toBe(false);
    expect(alive(group.member)).toBe(false);
  }, 20_000);

  test('a zombie in the group does not refuse a stop whose group empties once its parent is killed', async () => {
    const wait = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,';
    const group = await startGroup(
      "process.on('SIGTERM', () => process.exit(0));",
      `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); ${wait} 500); READY; ${wait} 600000)`,
    );
    await vi.waitFor(() => expect(execFileSync('ps', ['-axo', 'pid=,pgid=,stat=']).toString()).toMatch(/\sZ\S*\s*$/m), {
      timeout: 5000,
    });
    await stopProcessGroup(group, { termMs: 500 });
    expect(processGroupAlive(group.pid)).toBe(false);
    expect(alive(group.member)).toBe(false);
  }, 20_000);

  test('a leader whose identity cannot be read is refused without a signal, naming the check', async () => {
    const group = await startGroup('', 'READY; setInterval(() => {}, 1000)');
    await expect(stopProcessGroup({ pid: group.pid, processToken: 'unreadable' }, { termMs: 500 })).rejects.toThrow(
      /process group \d+: the leader's identity reads unknown, so no signal was sent/,
    );
    expect(alive(group.pid)).toBe(true);
    expect(alive(group.member)).toBe(true);
  }, 20_000);
});
