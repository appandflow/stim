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
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { maintenanceDir, stimdClaimRoot } from '@stim-cli/core/state';
import { createStim } from '../api.ts';
import { runGc } from '../commands/gc.ts';
import { runGcThroughStimd } from '../daemon/client.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { killStimdUnder } from '../../../../vitest.kill-run-processes.ts';
import { testContext } from './_context.ts';

const opened = vi.hoisted(() => new Set<Socket>());
const refusal = vi.hoisted(() => ({ after: -1, refused: false }));
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  return {
    ...actual,
    connect: (...args: Parameters<typeof actual.connect>) => {
      const refuse = refusal.after === 0;
      if (refusal.after >= 0) refusal.after--;
      if (refuse) refusal.refused = true;
      const socket = refuse ? actual.connect({ path: `${String(args[0])}.missing` }) : actual.connect(...args);
      opened.add(socket);
      socket.once('close', () => opened.delete(socket));
      return socket;
    },
  };
});

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gc-stimd-')));
});
afterEach(() => {
  vi.unstubAllEnvs();
  Object.assign(refusal, { after: -1, refused: false });
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
  mkdirSync(join(home, 'maintenance'));
  writeFileSync(join(home, 'maintenance', 'disk-reserve'), Buffer.alloc(1024 * 1024));
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
    PATH: [bin, process.env.PATH].join(delimiter),
  };
  return { root, home, cache, env };
}

const stimdOwner = () => readClaimSet(stimdClaimRoot()).live[0]?.owner;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Starts an acting gc at critical on stimd whose size walk records its pid and waits until `go` exists, through the
 * API's `collectGarbage` when `report` is set, whose 60 s report budget then runs out when `expire` is called.
 */
async function heldGc(controller: AbortController, report = false) {
  const marker = join(scratch, 'du.pid');
  const go = join(scratch, 'go');
  const item = fixture(`echo $$ > '${marker}'\nwhile [ ! -f '${go}' ]; do sleep 0.1; done\nexec /usr/bin/du "$@"`);
  const operation = testContext({
    home: item.home,
    projectRoot: item.root,
    cwd: item.root,
    env: item.env,
    signal: controller.signal,
  });
  const realSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const budget = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...rest) => {
    if (!report || ms !== 60_000 || expire) return realSetTimeout(callback, ms, ...rest);
    expire = () => callback();
    return realSetTimeout(() => {}, 2 ** 30);
  });
  const gc = report
    ? createStim({ projectRoot: item.root, home: item.home, env: item.env }).collectGarbage({
        pressure: 'critical',
        signal: controller.signal,
      })
    : withAmbientContext(operation, () =>
        runGcThroughStimd({ level: 'critical', client: 'manual' }, operation, () => {}),
      );
  void gc.catch(() => {});
  await vi
    .waitFor(
      () => {
        if (!existsSync(marker)) throw new Error('the pass has not reached its size walk');
      },
      { timeout: 20_000, interval: 100 },
    )
    .finally(() => budget.mockRestore());
  return { item, gc, go, expire, du: Number(readFileSync(marker, 'utf8')) };
}

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

  test('a refused GC connection after hello restores the reserve before any pass starts', async () => {
    const item = fixture();
    writeFileSync(join(item.home, 'config.json'), JSON.stringify({ daemon: { mode: 'on' } }));
    await createStim({ projectRoot: item.root, home: item.home, env: item.env }).collectGarbage({ pressure: 'normal' });
    const operation = testContext({ home: item.home, projectRoot: item.root, cwd: item.root, env: item.env });
    refusal.after = 2;
    await expect(
      withAmbientContext(operation, () =>
        runGcThroughStimd({ level: 'critical', client: 'manual' }, operation, () => {}),
      ),
    ).rejects.toMatchObject({ code: 'STIM_DAEMON_UNAVAILABLE' });
    expect(refusal.refused).toBe(true);
    expect(readFileSync(join(maintenanceDir(), 'disk-reserve')).length).toBe(1024 * 1024);
    expect(readFileSync(join(item.cache, 'artifact'), 'utf8')).toBe('cached');
  }, 45_000);

  test("a pass's native child stops when its only requester leaves", async () => {
    const controller = new AbortController();
    const { item, gc, du } = await heldGc(controller);
    try {
      controller.abort();
      await expect(gc).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(
        () => {
          if (alive(du)) throw new Error('the size walk still runs');
        },
        { timeout: 20_000, interval: 100 },
      );
      expect(readFileSync(join(item.cache, 'artifact'), 'utf8')).toBe('cached');
    } finally {
      if (alive(du)) process.kill(du, 'SIGKILL');
    }
  }, 45_000);

  test('a collectGarbage report that ran out of budget leaves the stimd it started and its pass running once the caller closes its sockets', async () => {
    const controller = new AbortController();
    const { item, gc, go, expire, du } = await heldGc(controller, true);
    try {
      if (!expire) throw new Error('collectGarbage set no report budget');
      expire();
      await expect(gc).rejects.toMatchObject({ code: 'STIM_REPORT_TIMEOUT' });
      expect(existsSync(join(maintenanceDir(), 'disk-reserve'))).toBe(false);
      for (const socket of opened) {
        await Promise.race([once(socket, 'close'), new Promise((done) => setTimeout(done, 1000))]);
        socket.destroy();
      }
      writeFileSync(go, '');
      await vi.waitFor(
        () => {
          if (existsSync(join(item.cache, 'artifact'))) throw new Error('the pass has not deleted the cache');
          expect(readFileSync(join(maintenanceDir(), 'disk-reserve')).length).toBe(1024 * 1024);
        },
        { timeout: 20_000, interval: 200 },
      );
    } finally {
      if (alive(du)) process.kill(du, 'SIGKILL');
    }
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
