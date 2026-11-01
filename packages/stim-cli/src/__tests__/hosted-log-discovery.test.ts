import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followHostedLogs } from '../device-host/hosted-logs-sync.ts';
import { workspaceStateFile } from '../workspace/paths.ts';
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
  vi.clearAllTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  delete process.env.STIM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function stateReads(): number {
  return vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => String(file) === workspaceStateFile(root)).length;
}

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
