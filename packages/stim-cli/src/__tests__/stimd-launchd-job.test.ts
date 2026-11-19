import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchStimd } from '../daemon/client.ts';
import { parsePlist } from '../engine/ios-profile.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stimd-launchd-job-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a command-started stimd on macOS', () => {
  it('runs as an Interactive launchd job, so launchd does not throttle it or its children', () => {
    const bootstrapped: unknown[] = [];
    setExecutor({
      runFile: (file: string, [verb, , plist]: string[]) => {
        if (file === 'launchctl' && verb === 'bootstrap' && plist)
          bootstrapped.push(parsePlist(readFileSync(plist, 'utf8')));
        return '';
      },
    });
    launchStimd({ HOME: home }, 'on', 'darwin', '/engine/dist/cli.mjs');
    expect(bootstrapped).toEqual([
      expect.objectContaining({
        ProgramArguments: [process.execPath, '/engine/dist/cli.mjs', '__stimd', '--mode', 'on'],
        ProcessType: 'Interactive',
      }),
    ]);
  });
});
