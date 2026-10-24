import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { followHostedLogs } from '../device-host/hosted-logs-sync.ts';
import { workspaceDir, workspaceStateFile } from '../workspace/paths.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';

let home: string;
let root: string;
let stop: () => void;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'stim-hosted-discovery-')));
  process.env.STIM_HOME = home;
  root = join(home, 'app');
  fs.mkdirSync(root);
  vi.spyOn(fs, 'readFileSync');
  syncBuiltinESMExports();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  stop = () => {};
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  delete process.env.STIM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function stateReads(): number {
  return vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => String(file) === workspaceStateFile(root)).length;
}

test('quiet discovery does no repeated state reads, file changes invalidate it, and stop releases both triggers', async () => {
  writeWorkspaceState(root, {});
  stop = followHostedLogs(root, false);
  const initial = stateReads();
  expect(initial).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(stateReads()).toBe(initial);

  writeWorkspaceState(root, { discoveryFixture: 1 });
  const afterWrite = stateReads();
  await vi.waitFor(() => expect(stateReads()).toBeGreaterThan(afterWrite), { timeout: 1000 });

  stop();
  writeWorkspaceState(root, { discoveryFixture: 2 });
  const afterStop = stateReads();
  await vi.advanceTimersByTimeAsync(20_000);
  await setImmediate();
  expect(stateReads()).toBe(afterStop);
});

test.each(['unavailable', 'error'])('discovery repairs a watcher that is %s', async (failure) => {
  writeWorkspaceState(root, {});
  const watch = vi.spyOn(fs, 'watch');
  if (failure === 'unavailable')
    watch.mockImplementationOnce(() => {
      throw new Error('Watcher unavailable');
    });
  syncBuiltinESMExports();
  stop = followHostedLogs(root, false);
  if (failure === 'error') watch.mock.results[0]?.value.emit('error', new Error('Watcher failed'));
  const initial = stateReads();
  await vi.advanceTimersByTimeAsync(9999);
  expect(stateReads()).toBe(initial);
  await vi.advanceTimersByTimeAsync(1);
  expect(stateReads()).toBeGreaterThan(initial);

  writeWorkspaceState(root, { discoveryFixture: 1 });
  const afterWrite = stateReads();
  await vi.waitFor(() => expect(stateReads()).toBeGreaterThan(afterWrite), { timeout: 1000 });
});

test.each([false, true])('discovery recovers a late or replaced state directory (late=%s)', async (late) => {
  if (!late) writeWorkspaceState(root, {});
  stop = followHostedLogs(root, false);
  if (!late) fs.rmSync(workspaceDir(root), { recursive: true });
  writeWorkspaceState(root, {});
  const afterCreation = stateReads();
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.waitFor(() => expect(stateReads()).toBeGreaterThan(afterCreation), { timeout: 1000 });

  writeWorkspaceState(root, { discoveryFixture: 1 });
  const afterWrite = stateReads();
  await vi.waitFor(() => expect(stateReads()).toBeGreaterThan(afterWrite), { timeout: 1000 });
});
