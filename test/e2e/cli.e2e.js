import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = new URL('../../packages/stim-cli/', import.meta.url);
const version = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')).version;
const entries = ['bin/cli.ts', 'dist/cli.mjs'];
let home;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-cli-e2e-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function run(entry, args, allowedCommand) {
  const nodeArgs = [];
  if (allowedCommand !== undefined) {
    const hook = `
      import { registerHooks } from 'node:module';
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === '@expo/fingerprint' ||
              (specifier.includes('/commands/') && !specifier.endsWith('/${allowedCommand}.ts'))) {
            throw new Error('Unexpected command dependency: ' + specifier);
          }
          return nextResolve(specifier, context);
        }
      });
    `;
    nodeArgs.push('--import', `data:text/javascript,${encodeURIComponent(hook)}`);
  }
  return spawnSync(process.execPath, [...nodeArgs, fileURLToPath(new URL(entry, packageRoot)), ...args], {
    env: process.env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

for (const entry of entries) {
  test(`${entry}: version prints without loading commands`, () => {
    for (const flag of ['--version', '-V']) {
      const result = run(entry, [flag], 'none');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), version);
    }
  });

  test(`${entry}: guides render without loading other commands or fingerprinting`, () => {
    for (const args of [['guide'], ['guide', 'agent'], ['guide', 'errors', 'STIM_NO_METRO']]) {
      const result = run(entry, args, 'guide');
      assert.equal(result.status, 0, result.stderr);
      assert(result.stdout.trim());
    }
  });

  test(`${entry}: direct and help-command routes retain the same options`, () => {
    for (const command of ['guide', 'start', 'worktree', 'device', 'ios', 'android']) {
      const direct = run(entry, [command, '--help']);
      const help = run(entry, ['help', command]);
      assert.equal(direct.status, 0, direct.stderr);
      assert.equal(help.status, 0, help.stderr);
      assert.equal(help.stdout, direct.stdout);
      assert.match(direct.stdout, new RegExp(`Usage: stim ${command} `));
    }
    const nested = run(entry, ['device', 'lock', '--help']);
    assert.equal(nested.status, 0, nested.stderr);
    assert.match(nested.stdout, /Usage: stim device lock /);
    assert.match(nested.stdout, /--for <duration>/);
  });

  test(`${entry}: root help and unknown-command suggestions include other commands`, () => {
    const help = run(entry, ['--help']);
    assert.equal(help.status, 0, help.stderr);
    for (const command of [
      'doctor',
      'worktree',
      'start',
      'stop',
      'ios',
      'android',
      'reload',
      'device',
      'logs',
      'status',
      'stats',
      'gc',
      'guide',
    ]) {
      assert.match(help.stdout, new RegExp(`\\n  ${command}[ \\[]`));
    }
    const unknown = run(entry, ['strt']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Did you mean start/);
  });

  test(`${entry}: selected commands retain JSON errors and literal arguments`, () => {
    const invalid = run(entry, ['start', '--wait', '0', '--json']);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).code, 'STIM_BAD_ARG');
    const literal = run(entry, ['guide', '--', '--version']);
    assert.equal(literal.status, 1);
    assert.notEqual(literal.stdout.trim(), version);
  });
}
