import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

function parseEnvironment(output: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of output.split('\0')) {
    const equals = entry.indexOf('=');
    if (equals > 0) environment[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return environment;
}

/**
 * The login shell's environment, as Stim Desktop captures it: a process started by launchd lacks the
 * PATH entries and variables such as ANDROID_HOME that the shell profile sets. The shell writes to a
 * file because a background process started by a profile can keep a pipe open after the shell exits.
 */
export function loginShellEnvironment(scratchDir: string): Record<string, string> | null {
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const file = join(scratchDir, `.login-env.${process.pid}`);
  try {
    spawnSync(process.env.SHELL || '/bin/zsh', ['-lic', 'command env -0 > "$1"', 'stim-server', file], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    const environment = parseEnvironment(readFileSync(file, 'utf8'));
    return Object.keys(environment).length ? environment : null;
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

/** The `stim` CLI this package depends on, run with this Node.js binary. */
export function bundledStim(): { cli: string; version: string } {
  const manifest = createRequire(import.meta.url).resolve('stim/package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string; bin: { stim: string } };
  return { cli: join(dirname(manifest), pkg.bin.stim), version: pkg.version };
}
