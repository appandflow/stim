import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { decode } from 'unique-pid';
import { getExecutor } from '../exec.ts';
import { captureProcessToken } from '../process-identity.ts';
import { verifyCollectorOwnership } from '../collector/ownership.ts';
import { registerCollector, unregisterCollector, readCollectors } from '../collector/state.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-owned-collector-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('persisted identity recognizes a live child without argv and refuses other workspaces, platforms and lifetimes', async () => {
  const root = join(home, 'project with spaces');
  const alias = join(home, 'alias');
  mkdirSync(root);
  symlinkSync(root, alias);
  const child = getExecutor().spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    await once(child, 'spawn');
    const pid = child.pid!;
    const processToken = captureProcessToken(pid);
    expect(processToken).toBeTruthy();
    registerCollector(root, 'ios', { pid, processToken });
    expect(verifyCollectorOwnership({ pid, root, platform: 'ios' })).toEqual({ status: 'ours' });
    expect(verifyCollectorOwnership({ pid, root: alias, platform: 'ios' })).toEqual({ status: 'ours' });
    expect(verifyCollectorOwnership({ pid, root, platform: 'android' }).status).toBe('unverified');
    expect(verifyCollectorOwnership({ pid, root: join(home, 'other'), platform: 'ios' }).status).toBe('unverified');
    registerCollector(root, 'ios', { pid, startedAt: new Date().toISOString() });
    expect(verifyCollectorOwnership({ pid, root, platform: 'ios' }).status).toBe('unverified');
    registerCollector(root, 'ios', { pid, processToken: 'invalid' });
    expect(verifyCollectorOwnership({ pid, root, platform: 'ios' }).status).toBe('unverified');
    const parsed = decode(processToken!);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const identity = parsed.value;
    const start = identity.startTime.split(':');
    start[0] = String(BigInt(start[0]!) + 1n);
    const replacement =
      'upid1.' + Buffer.from(JSON.stringify({ ...identity, startTime: start.join(':') })).toString('base64url');
    registerCollector(root, 'ios', { pid, processToken: replacement });
    expect(verifyCollectorOwnership({ pid, root, platform: 'ios' })).toEqual({ status: 'gone' });
    unregisterCollector(root, 'ios', pid, processToken!);
    expect(readCollectors(root).ios).toEqual({ pid, processToken: replacement });
    registerCollector(root, 'ios', { pid, processToken });
    expect(
      verifyCollectorOwnership({ pid, root, platform: 'ios', expected: { pid, processToken: replacement } }).status,
    ).toBe('unverified');
    child.kill('SIGTERM');
    await exited;
    expect(verifyCollectorOwnership({ pid, root, platform: 'ios' })).toEqual({ status: 'gone' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});
