import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-cli-hung-read-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32' || !process.execve)(
  'a command that finishes with a native read still pending',
  () => {
    test.each([
      { args: ['settings', 'get', 'iosSimulatorApp'], preset: undefined, status: 0 },
      { args: ['settings', 'get', 'iosSimulatorApp'], preset: 130, status: 130 },
      { args: ['settings', 'get', 'notASetting'], preset: undefined, status: 1 },
    ])('exits with its own code: $args, process.exitCode $preset', ({ args, preset, status }) => {
      const fifo = join(dir, 'fifo');
      execFileSync('mkfifo', [fifo]);
      const script = join(dir, 'run.mjs');
      writeFileSync(
        script,
        `import { readFile } from 'node:fs/promises';
Reflect.set(globalThis, Symbol.for('stim.main'), true);
const { answered, hungRead } = await import(${JSON.stringify(fileURLToPath(new URL('../workspace/bounded-read.ts', import.meta.url)))});
const { main } = await import(${JSON.stringify(fileURLToPath(new URL('../../bin/cli.ts', import.meta.url)))});
await answered('fifo', () => readFile(${JSON.stringify(fifo)}), 10).catch(() => {});
if (hungRead() === null) process.exit(99);
process.exitCode = ${JSON.stringify(preset ?? null)} ?? undefined;
await main(['node', 'stim', ...${JSON.stringify(args)}]);
`,
      );
      const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, STIM_HOME: join(dir, 'home'), STIM_DAEMON: 'off' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.signal).toBeNull();
      expect(result.status).toBe(status);
    });
  },
);
