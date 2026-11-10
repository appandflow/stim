import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { stimBuildId, stimdClaimRoot, stimdRecordFile, stimdRunDir, stimdSocket } from '@stim-cli/core/state';
import { machineCopy } from './fixtures/machine-copy.ts';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
let home: string;
let server: Server | null = null;
let claim: ClaimHandle | null = null;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-other-build-')));
  process.env.STIM_HOME = home;
});

afterEach(async () => {
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = null;
  releaseClaim(claim);
  claim = null;
  vi.resetModules();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test.each([
  {
    stimd: 'of another installation',
    reply: { version: '1.0.0-other' },
    message: '1.0.0-other',
  },
  {
    stimd: 'that hands over once its live shares end',
    reply: { version: '1.0.0-other', handover: true, heldBy: 'shares' },
    message: 'serves live web shares',
  },
])('share list names a stimd $stimd and how to replace it, not that no stimd runs', async ({ reply, message }) => {
  const socket = stimdSocket();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
  server = createServer((connection) => {
    connection.resume();
    connection.end(`${JSON.stringify({ op: 'engine-changed', build: 'aaaaaaaaaaaa', pid: 4242, ...reply })}\n`);
  });
  await new Promise<void>((done) => server?.listen(socket, done));
  vi.resetModules();
  const { runShare } = await import('../commands/share.ts');
  const { otherBuildRefusal } = await import('../daemon/client.ts');
  const { requestLocalServer } = await import('../local-server.ts');

  const result = await runShare(
    'list',
    {},
    {
      findWorkspace: async () => null,
      request: (method, params) => requestLocalServer(method, params, { version: '9.9.9' }),
      startServer: async () => null,
      otherBuild: otherBuildRefusal,
      note: () => {},
      platform: 'darwin',
    },
    '9.9.9',
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'STIM_DAEMON_UNAVAILABLE',
      message: expect.stringContaining(message),
      remedy: expect.stringContaining('kill 4242'),
    },
  });
});

test('stim share waits for a stimd that holds its claim but does not listen yet', async () => {
  const socket = stimdSocket();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
  server = createServer((connection) => {
    let lines = 0;
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      for (const _ of chunk.matchAll(/\n/g)) {
        lines++;
        connection.write(
          `${JSON.stringify(lines === 1 ? { op: 'hello' } : { op: 'net', listening: true, port: 4321 })}\n`,
        );
      }
    });
  });
  const listening = new Promise<void>((done) => setTimeout(() => server?.listen(socket, done), 300));
  vi.resetModules();
  const { ensureNet } = await import('../daemon/client.ts');

  expect(await ensureNet(true)).toEqual({ listening: true, port: 4321 });
  await listening;
});

test.skipIf(process.platform === 'win32')('a command names every unresolved daemon claim in one refusal', async () => {
  const ownership = new URL('../ownership-claim.ts', import.meta.url).href;
  const state = new URL('../../../core/state/index.ts', import.meta.url).href;
  const script = `import { markClaimChildPending, tryAcquireClaim } from ${JSON.stringify(ownership)};
import { daemonClaimRoot, stimdClaimRoot } from ${JSON.stringify(state)};
for (const [root, mode] of [[stimdClaimRoot(), 'exclusive'], [daemonClaimRoot(), 'shared']])
  markClaimChildPending(tryAcquireClaim({ root, mode, label: 'stimd' }).acquired);`;
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--input-type=module', '-e', script],
    { env: process.env, stdio: 'inherit' },
  );
  expect((await once(child, 'exit'))[0]).toBe(0);
  vi.resetModules();
  const { ensureStimd } = await import('../daemon/client.ts');

  let refusal: unknown;
  try {
    await ensureStimd({ ...process.env, STIM_DAEMON: 'on' }, process.platform, true);
  } catch (error) {
    refusal = error;
  }

  assert(refusal instanceof Error);
  expect(refusal).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
  const { message } = refusal;
  const remedy = 'remedy' in refusal ? String(refusal.remedy) : '';
  for (const part of ['run/stimd', 'daemon/claim']) {
    expect(message).toContain(join(home, part));
    expect(remedy).toContain(join(home, part));
  }
});

/**
 * The next tree of `dist` as a package update writes it: every hashed chunk has another name, so once it replaces
 * `dist` the old chunks are gone from disk.
 */
function nextDist(dist: string): string {
  const next = `${dist}.next`;
  cpSync(dist, next, { recursive: true });
  const chunks = readdirSync(next).filter((name) => /-[\w-]{8}\.mjs$/.test(name));
  const renamed = (text: string) =>
    chunks.reduce((out, name) => out.replaceAll(name, name.replace(/\.mjs$/, 'u.mjs')), text);
  for (const name of readdirSync(next).filter((entry) => entry.endsWith('.mjs'))) {
    writeFileSync(join(next, renamed(name)), renamed(readFileSync(join(next, name), 'utf8')));
    if (chunks.includes(name)) rmSync(join(next, name));
  }
  return next;
}

function replaceDist(dist: string, next: string): void {
  renameSync(dist, `${dist}.old`);
  renameSync(next, dist);
  rmSync(`${dist}.old`, { recursive: true, force: true });
}

test.skipIf(process.platform === 'win32')(
  'a stimd whose own installation was updated in place hands the home to a stimd of the new build',
  async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-in-place-')));
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    for (const tool of ['launchctl', 'systemd-run']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\nexit 1\n');
      chmodSync(join(bin, tool), 0o755);
    }
    const env = {
      ...process.env,
      HOME: tmp,
      STIM_HOME: home,
      STIM_ENGINE_ROOT: join(tmp, 'engine'),
      STIM_DAEMON: 'on',
      PATH: `${bin}:${process.env.PATH}`,
    };
    const dist = join(machineCopy(PACKAGE, join(tmp, 'prefix')), 'dist');
    const record = (): { pid: number; build: string } | null => {
      try {
        return JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
      } catch {
        return null;
      }
    };
    const until = async (what: string, check: () => boolean) => {
      for (const deadline = Date.now() + 20_000; !check();) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((done) => setTimeout(done, 20));
      }
    };
    const first = (build: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = connect(stimdSocket());
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          const end = buffer.indexOf('\n');
          if (end < 0) return;
          socket.destroy();
          resolve(JSON.parse(buffer.slice(0, end)));
        });
        socket.once('error', reject);
        socket.once('connect', () => socket.write(`${JSON.stringify({ kind: 'cli', build })}\n`));
      });
    const stimds: ChildProcess[] = [];
    try {
      stimds.push(
        spawn(process.execPath, [join(dist, 'cli.mjs'), '__stimd', '--mode', 'on'], {
          env,
          cwd: tmp,
          stdio: 'ignore',
          detached: true,
        }),
      );
      const before = stimBuildId(dist);
      assert(before);
      await until('the stimd of the installed build', () => record()?.build === before);
      const pid = record()?.pid;

      const next = nextDist(dist);
      const after = stimBuildId(next);
      assert(after);
      const early = await first(after);
      expect(early).toMatchObject({ op: 'engine-changed', pid });
      expect(early).not.toHaveProperty('handover');
      expect(await first(before)).toMatchObject({ op: 'hello', pid });

      replaceDist(dist, next);
      expect(await first(after)).toMatchObject({ op: 'engine-changed', pid, handover: true });
      await until('the stimd of the updated build', () => record()?.build === after && record()?.pid !== pid);
    } finally {
      const pids = [record()?.pid, ...stimds.map((stimd) => stimd.pid)].filter((pid) => pid !== undefined);
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (const pid of pids.filter(alive)) process.kill(pid, 'SIGTERM');
      await until('the stimds to exit', () => !pids.some(alive));
      rmSync(tmp, { recursive: true, force: true });
    }
  },
  120_000,
);
