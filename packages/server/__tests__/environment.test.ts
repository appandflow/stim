import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginShellEnvironment } from '../src/environment.ts';

describe.skipIf(process.platform === 'win32')('login shell environment', () => {
  it('captures null-delimited values and removes the temporary environment file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-shell-test-'));
    const shell = join(dir, 'shell');
    const marker = join(dir, 'marker');
    writeFileSync(
      shell,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
const file = process.argv.at(-1);
writeFileSync(${JSON.stringify(marker)}, file);
writeFileSync(file, 'PATH=/custom/bin\\0TOKEN=one=two\\0MULTILINE=one\\ntwo\\0');
`,
      { mode: 0o700 },
    );
    vi.stubEnv('SHELL', shell);
    try {
      expect(loginShellEnvironment()).toEqual({ PATH: '/custom/bin', TOKEN: 'one=two', MULTILINE: 'one\ntwo' });
      expect(existsSync(readFileSync(marker, 'utf8'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no environment after 15 seconds when the direct shell ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-shell-test-'));
    const shell = join(dir, 'shell');
    const marker = join(dir, 'marker');
    writeFileSync(
      shell,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, file: process.argv.at(-1) }));
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const source = new URL('../src/environment.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { loginShellEnvironment } from ${JSON.stringify(source)};
const start = Date.now();
process.stdout.write(JSON.stringify({ environment: loginShellEnvironment(), elapsed: Date.now() - start }));`,
      ],
      { env: { ...process.env, SHELL: shell, TMPDIR: dir }, detached: true, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const guard = setTimeout(() => process.kill(-child.pid!, 'SIGKILL'), 22_000);
    try {
      const [code] = await once(child, 'close');
      expect(code).toBe(0);
      const result = JSON.parse(output) as { environment: unknown; elapsed: number };
      expect(result.environment).toBeNull();
      expect(result.elapsed).toBeGreaterThanOrEqual(14_000);
      expect(result.elapsed).toBeLessThan(22_000);
      const fixture = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; file: string };
      expect(() => process.kill(fixture.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      expect(existsSync(fixture.file)).toBe(false);
    } finally {
      clearTimeout(guard);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
});
