import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readClaimSet } from '@stim-cli/core/ownership-claim';

const execute = promisify(execFile);
const root = join(import.meta.dirname, '../../../..');

test('the router reports its package version and serving retains the service process pid through shutdown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-serve-cli-'));
  const env = { ...process.env, STIM_HOME: home, HOME: home, USERPROFILE: home };
  const version = JSON.parse(readFileSync(join(root, 'packages/stim-cli/package.json'), 'utf8')).version;
  try {
    const printed = await execute(process.execPath, [join(root, 'packages/stim-cli/bin/stim.mjs'), '--version'], {
      env,
    });
    expect(printed.stdout.trim()).toBe(version);
    const child = spawn(
      process.execPath,
      [join(root, 'packages/stim-cli/bin/cli.ts'), 'serve', '--service', '--share', '--port', '0'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    let output = '';
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`Server exited before listening: ${output}\n${errors}`)));
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          const match = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output);
          if (match) resolve(Number(match[1]));
        });
      });
      const signal = AbortSignal.timeout(10_000);
      let response;
      let health;
      do {
        response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
        health = await response.json();
      } while (response.status === 503);
      expect(response.status).toBe(200);
      expect(health).toMatchObject({ server: 'stim-server', version });
      const claims = readClaimSet(join(home, 'server', 'share-server')).live;
      expect(claims).toHaveLength(1);
      expect(claims[0]?.owner.pid).toBe(child.pid);
      child.kill('SIGTERM');
      expect(await exited).toEqual([0, null]);
      expect(readClaimSet(join(home, 'server', 'share-server'))).toEqual({
        live: [],
        dead: [],
        unresolved: [],
        orphans: [],
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
