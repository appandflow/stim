import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { stimdClaimRoot } from '@stim-cli/core/state';
import { createStim } from '../api.ts';
import { runGc } from '../commands/gc.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { killStimdUnder } from '../../../../vitest.kill-run-processes.ts';
import { testContext } from './_context.ts';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gc-stimd-')));
});
afterEach(() => {
  vi.unstubAllEnvs();
  killStimdUnder(scratch);
  rmSync(scratch, { recursive: true, force: true });
});

/** A home with daemon.mode off and one registered cache, and a PATH whose `du` is `du` when given. */
function fixture(du?: string) {
  const root = join(scratch, 'app');
  const home = join(scratch, 'home');
  const cache = join(home, 'cache');
  const bin = join(scratch, 'bin');
  mkdirSync(root);
  mkdirSync(cache, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', private: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { mode: 'off' } }));
  writeFileSync(
    join(home, 'caches.json'),
    JSON.stringify({ version: 1, caches: [{ name: 'fixture', dir: cache, prune: 'entries' }] }),
  );
  writeFileSync(join(cache, 'artifact'), 'cached');
  if (du) {
    writeFileSync(join(bin, 'du'), `#!/bin/sh\n${du}\n`);
    chmodSync(join(bin, 'du'), 0o755);
  }
  vi.stubEnv('STIM_HOME', home);
  const env = {
    ...process.env,
    HOME: scratch,
    STIM_HOME: home,
    STIM_ENGINE_ROOT: join(home, 'engine'),
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
  };
  return { root, home, cache, env };
}

const stimdOwner = () => readClaimSet(stimdClaimRoot()).live[0]?.owner;

describe.skipIf(process.platform === 'win32')('gc on stimd', () => {
  test('an acting gc starts a stimd under daemon.mode off, which runs the pass and exits after it', async () => {
    const item = fixture();
    let owner: ReturnType<typeof stimdOwner>;
    const result = await createStim({
      projectRoot: item.root,
      home: item.home,
      env: item.env,
      onProgress: () => {
        owner ??= stimdOwner();
      },
    }).collectGarbage({ pressure: 'critical' });
    expect(result.report).toMatchObject({ mode: 'delete', level: 'critical' });
    expect(result.report).not.toHaveProperty('joined');
    expect(existsSync(join(item.cache, 'artifact'))).toBe(false);
    if (!owner) throw new Error('No stimd held the home while the pass ran');
    expect(owner.pid).not.toBe(process.pid);
    const ran = owner;
    await vi.waitFor(
      () => {
        if (inspectProcessIdentity(ran) === 'same') throw new Error('the stimd still runs');
      },
      { timeout: 20_000, interval: 200 },
    );
  }, 45_000);

  test('a stimd killed during the pass fails gc with the remedy to run it again', async () => {
    const marker = join(scratch, 'du.pid');
    const item = fixture(`echo $$ > '${marker}'\nexec sleep 600`);
    const operation = testContext({ home: item.home, projectRoot: item.root, cwd: item.root, env: item.env });
    const stdout: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => void stdout.push(args.join(' ')));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let du: number | undefined;
    try {
      const gc = withAmbientContext(operation, () => runGc({ pressure: 'critical', json: true }, { operation }));
      await vi.waitFor(
        () => {
          if (!existsSync(marker)) throw new Error('the pass has not reached its size walk');
        },
        { timeout: 20_000, interval: 100 },
      );
      du = Number(readFileSync(marker, 'utf8'));
      const owner = stimdOwner();
      if (!owner) throw new Error('No stimd holds the home');
      process.kill(owner.pid, 'SIGKILL');
      await gc;
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (du) process.kill(du, 'SIGKILL');
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      code: 'STIM_DAEMON_UNAVAILABLE',
      message: expect.stringContaining('stopped while this command was running'),
      remedy: expect.stringContaining('Run the command again'),
    });
    expect(readFileSync(join(item.cache, 'artifact'), 'utf8')).toBe('cached');
  }, 45_000);
});
