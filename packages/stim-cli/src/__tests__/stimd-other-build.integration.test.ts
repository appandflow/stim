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
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import {
  daemonClaimRoot,
  stimBuildId,
  stimdClaimRoot,
  stimdRecordFile,
  stimdRunDir,
  stimdSocket,
} from '@stim-cli/core/state';
import { parseNdjsonText } from '../ndjson.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { machineCopy } from './fixtures/machine-copy.ts';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
let home: string;
let server: Server | null = null;
let claim: ClaimHandle | null = null;
let daemonClaim: ClaimHandle | null = null;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-other-build-')));
  process.env.STIM_HOME = home;
});

afterEach(async () => {
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = null;
  releaseClaim(claim);
  claim = null;
  releaseClaim(daemonClaim);
  daemonClaim = null;
  vi.resetModules();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test.each([
  {
    stimd: 'of another installation',
    reply: { version: '1.0.0-other' },
    message: '1.0.0-other',
    remedy: 'kill 4242',
  },
  {
    stimd: 'that hands over once its device log streams end',
    reply: { version: '1.0.0-other', handover: true, heldBy: 'logs', workspaces: ['/work/app'] },
    message: 'streams device logs for /work/app',
    remedy: 'npx stim@1.0.0-other stop',
  },
  {
    stimd: 'that hands over once the dev servers it stops on exit end',
    reply: { version: '1.0.0-other', handover: true, heldBy: 'dev-servers', workspaces: ['/work/app'] },
    message: 'dev servers of /work/app',
    remedy: 'npx stim@1.0.0-other stop',
  },
  {
    stimd: 'that hands over once its live shares end',
    reply: { version: '1.0.0-other', handover: true, heldBy: 'shares' },
    message: 'serves live web shares',
    remedy: 'kill 4242',
  },
  {
    stimd: 'that waits for a child whose cleanup it could not verify',
    reply: { version: '1.0.0-other' },
    waiting: 5150,
    message: 'waits for child 5150',
    remedy: 'kill 4242',
  },
])(
  'share list names a stimd $stimd and how to replace it, not that no stimd runs',
  async ({ reply, message, remedy, waiting }) => {
    const socket = stimdSocket();
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
    claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
    if (waiting)
      daemonClaim =
        tryAcquireClaim({
          root: daemonClaimRoot(),
          mode: 'shared',
          label: 'test stimd',
          details: {
            unverified: [{ since: new Date().toISOString(), child: waiting, message: 'fixture', remedy: 'fixture' }],
          },
        }).acquired ?? null;
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
        remedy: expect.stringContaining(remedy),
      },
    });
  },
);

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

describe.skipIf(process.platform === 'win32')('unresolved daemon claims', () => {
  test.each([
    {
      daemonClaim: 'a pending claim file',
      directory: false,
      command: /rm -f [^;]*run\/stimd[^;]*; rm -f [^;]*daemon\/claim/,
    },
    {
      daemonClaim: 'an unreadable claim root',
      directory: true,
      command: /rm -f [^;]*run\/stimd[^;]*, then separately, .*rm -rf .*daemon\/claim/,
    },
  ])(
    'a command names every unresolved daemon claim, $daemonClaim included, in one refusal',
    async ({ directory, command }) => {
      const ownership = new URL('../ownership-claim.ts', import.meta.url).href;
      const state = new URL('../../../core/state/index.ts', import.meta.url).href;
      const script = `import { markClaimChildPending, tryAcquireClaim } from ${JSON.stringify(ownership)};
import { daemonClaimRoot, stimdClaimRoot } from ${JSON.stringify(state)};
const roots = [[stimdClaimRoot(), 'exclusive'], ...(${directory} ? [] : [[daemonClaimRoot(), 'shared']])];
for (const [root, mode] of roots) markClaimChildPending(tryAcquireClaim({ root, mode, label: 'stimd' }).acquired);`;
      const child = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--input-type=module', '-e', script],
        { env: process.env, stdio: 'inherit' },
      );
      expect((await once(child, 'exit'))[0]).toBe(0);
      const daemonRoot = join(home, 'daemon', 'claim');
      if (directory) {
        mkdirSync(dirname(daemonRoot), { recursive: true });
        writeFileSync(daemonRoot, '');
      }
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
      expect(remedy).toMatch(command);
    },
  );
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
  'a stimd whose own installation was updated in place hands the home and its log streams to a stimd of the new build',
  async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-in-place-')));
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    for (const tool of ['launchctl', 'systemd-run']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\nexit 1\n');
      chmodSync(join(bin, tool), 0o755);
    }
    const app = join(tmp, 'app');
    mkdirSync(app);
    upsertProject(app, {});
    const streamPids = join(tmp, 'stream-pids');
    writeFileSync(
      join(bin, 'xcrun'),
      `#!/bin/sh\necho $$ >> '${streamPids}'\nprintf '{"eventType":"logEvent","eventMessage":"line from %s"}\\n' $$\nexec sleep 600\n`,
    );
    chmodSync(join(bin, 'xcrun'), 0o755);
    const childPids = () => {
      try {
        return readFileSync(streamPids, 'utf8').trim().split('\n').filter(Boolean).map(Number);
      } catch {
        return [];
      }
    };
    const deviceLines = () => {
      try {
        return parseNdjsonText(readFileSync(join(workspaceLogsDir(app), 'device.ndjson'), 'utf8')).map((line) =>
          String(line.msg),
        );
      } catch {
        return [];
      }
    };
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
    const admitted = (build: string, params?: Record<string, unknown>) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = connect(stimdSocket());
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.includes('"op.begun"')) resolve(socket);
        });
        socket.once('error', reject);
        socket.once('connect', () =>
          socket.write(`${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op: 'op.begin', params })}\n`),
        );
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

      const streamOp = await admitted(before, {
        workspace: app,
        forwarded: { cwd: app, env: { PATH: env.PATH, HOME: tmp, STIM_HOME: home } },
      });
      const started = await new Promise<Record<string, unknown>>((resolve) => {
        let buffer = '';
        streamOp.on('data', (chunk: string) => {
          buffer += chunk;
          const line = buffer.split('\n').find((entry) => entry.includes('"logs.'));
          if (line) resolve(JSON.parse(line));
        });
        streamOp.write(
          `${JSON.stringify({ op: 'logs.start', params: { root: app, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' } })}\n`,
        );
      });
      expect(started).toMatchObject({ op: 'logs.started' });
      await until('the first device log line', () => childPids().length === 1 && deviceLines().length > 0);
      const [firstChild] = childPids();
      assert(firstChild !== undefined);
      streamOp.destroy();

      const next = nextDist(dist);
      const after = stimBuildId(next);
      assert(after);
      const early = await first(after);
      expect(early).toMatchObject({ op: 'engine-changed', pid });
      expect(early).not.toHaveProperty('handover');
      expect(await first(before)).toMatchObject({ op: 'hello', pid });

      const pinnedOp = await admitted(before);
      const waitingOp = await admitted(before);
      await new Promise<void>((resolve) => {
        waitingOp.on('data', (chunk: string) => {
          if (chunk.includes('"slot.waiting"')) resolve();
        });
        waitingOp.write(`${JSON.stringify({ op: 'op.wait' })}\n${JSON.stringify({ op: 'slot.wait' })}\n`);
      });
      replaceDist(dist, next);
      expect(await first(after)).toMatchObject({ op: 'engine-changed', pid, handover: true });
      pinnedOp.destroy();
      expect(await first(after)).toMatchObject({ op: 'engine-changed', pid, handover: true });
      expect(await first(before)).toMatchObject({ op: 'hello', pid });
      expect(waitingOp.closed).toBe(false);
      waitingOp.destroy();
      await until('the stimd of the updated build', () => record()?.build === after && record()?.pid !== pid);
      await until('the resumed device log stream', () => childPids().length === 2);
      const [, resumedChild] = childPids();
      await until('the resumed stream writing the workspace log', () =>
        deviceLines().includes(`line from ${resumedChild}`),
      );
      expect(deviceLines()).toContain(`line from ${firstChild}`);
      expect(() => process.kill(firstChild, 0)).toThrow('ESRCH');
      expect(readWorkspaceState(app)?.collectors?.ios).toMatchObject({
        kind: 'stream',
        streamId: started.streamId,
      });
    } finally {
      const pids = [record()?.pid, ...stimds.map((stimd) => stimd.pid), ...childPids()].filter(
        (pid) => pid !== undefined,
      );
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
