import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
export default function setup(): () => void {
  const previous = TMP_KEYS.map((key) => [key, process.env[key]] as const);
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'stim-vitest-'));
  for (const key of TMP_KEYS) process.env[key] = root;

  return () => {
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
