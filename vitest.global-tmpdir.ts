import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { killRunProcesses } from './vitest.kill-run-processes.ts';
import { launchdJobsUnder, removeLaunchdLeftovers } from './vitest.launchd-leftovers.ts';

// Directories Stim's own tests, and the tools they run, create in TMPDIR.
const TRACKED_PREFIXES = [
  'stim-claim-',
  'stim-host-',
  'stim-fakehome-',
  'stim-hosted-macos-',
  'stim-server-',
  'stim-ws-',
  'TemporaryDirectory',
];
const TMP_KEYS = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR'];

// Runs the suite in a TMPDIR of its own, so entries other processes on the
// machine create never count, and fails when the run leaves tracked entries in
// it. macOS gets /tmp because its default TMPDIR is long enough that tests
// binding Unix sockets under it exceed the 104-byte sun_path limit (macOS
// unix(4)).
export default function setup(project: TestProject): () => void {
  const previous = TMP_KEYS.map((key) => [key, process.env[key]] as const);
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'stim-vitest-'));
  for (const key of TMP_KEYS) process.env[key] = root;

  return () => {
    const { survivors: stimds, checked } = killRunProcesses(root);
    const jobs = launchdJobsUnder(root);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const leaked = readdirSync(root).filter((name) => TRACKED_PREFIXES.some((prefix) => name.startsWith(prefix)));
    const contents = leaked.slice(0, 3).map((name) => {
      try {
        return `${name} [${readdirSync(join(root, name)).slice(0, 5).join(', ')}]`;
      } catch {
        return name;
      }
    });
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
    if (!checked)
      process.stderr.write('Leftover stimd processes could not be checked: the process table was unreadable.\n');
    if (stimds.length > 0) {
      const list = stimds.map(({ pid, home }) => `${pid} serving ${home}`).join('; ');
      const message =
        `The test run left ${stimds.length} stimd ${stimds.length === 1 ? 'process' : 'processes'} running (${list}); the run stopped them. ` +
        `Stop the daemon a test starts in afterEach, afterAll or onTestFinished.`;
      let failed: number | undefined;
      try {
        failed = project.vitest.state.getCountOfFailedTests();
      } catch {}
      if (failed === 0) throw new Error(message);
      process.stderr.write(
        `${message}${failed === undefined ? ' The failed-test count could not be read, so the run does not fail for it.' : ` ${failed} tests failed, which may have left them; the run does not fail for them.`}\n`,
      );
    }
    if (jobs.length > 0) {
      const message =
        `The test run left ${jobs.length} stimd launchd ${jobs.length === 1 ? 'job' : 'jobs'} registered (${removeLaunchdLeftovers(jobs)}); the run removed them. ` +
        `A test that starts stimd must not reach the real launchd: vitest.setup.ts puts a refusing launchctl first on PATH, so a test with its own PATH must keep it, or put a stub launchctl before it.`;
      let failed: number | undefined;
      try {
        failed = project.vitest.state.getCountOfFailedTests();
      } catch {}
      if (failed === 0) throw new Error(message);
      process.stderr.write(
        `${message} ${failed ?? 'Some'} tests failed, which may have left them; the run does not fail for them.\n`,
      );
    }
    if (leaked.length === 0) return;
    const counts = new Map<string, number>();
    for (const name of leaked) {
      const prefix = TRACKED_PREFIXES.find((candidate) => name.startsWith(candidate)) ?? name;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    throw new Error(
      `The test run left ${leaked.length} ${leaked.length === 1 ? 'entry' : 'entries'} in TMPDIR: ${[...counts].map(([prefix, count]) => `${prefix}* x${count}`).join(', ')} ` +
        `(for example ${contents.join('; ')}). Remove what a test creates in afterEach, afterAll or onTestFinished.`,
    );
  };
}
