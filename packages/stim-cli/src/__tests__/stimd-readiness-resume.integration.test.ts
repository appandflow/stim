import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isJsonObject, stimdClaimRoot, stimdSocket } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import {
  admittedOpToken,
  deviceLogReadinessWait,
  ensureStimd,
  ensureTunnelThroughStimd,
  startDeviceLogStream,
} from '../daemon/client.ts';
import { operationState } from '../engine/operation-state.ts';
import { testContext } from './_context.ts';

// Control when the admission disappears and when the successor answers, independent of daemon startup time.
async function withSocketPeer<T>(
  respond: (request: Record<string, unknown>, socket: Socket, reply: (message: object) => void) => void,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-readmit-')));
  const home = join(root, 'home');
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_DAEMON', 'on');
  vi.stubEnv('STIM_ENGINE_ROOT', join(root, 'engine'));
  vi.stubEnv('XDG_RUNTIME_DIR', '');
  const path = stimdSocket();
  mkdirSync(join(path, '..'), { recursive: true });
  const claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'readmission peer' }).acquired;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.once('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', (chunk: string) => {
      input += chunk;
      const lines = input.split('\n');
      input = lines.pop() ?? '';
      for (const line of lines) {
        const value: unknown = JSON.parse(line);
        if (!isJsonObject(value) || typeof value.op !== 'string') continue;
        respond(value, socket, (message) =>
          socket.write(`${JSON.stringify({ op: 'hello' })}\n${JSON.stringify(message)}\n`),
        );
      }
    });
  });
  try {
    assert(claim);
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
    return await run(root);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    releaseClaim(claim);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('readiness across a lost daemon connection', () => {
  test.each(['resumed', 'refused'] as const)(
    'readiness handles a %s admission after losing the first daemon',
    async (outcome) => {
      let admission: Socket | undefined;
      let admissions = 0;
      const requests: Record<string, unknown>[] = [];
      const coverage = await withSocketPeer(
        (request, socket, reply) => {
          if (request.op === 'op.begin') {
            admissions++;
            if (admissions === 1) admission = socket;
            if (admissions === 2 && outcome === 'refused') {
              reply({ op: 'engine-changed', build: 'aaaaaaaaaaaa', version: '2.0.0-other' });
              return;
            }
            reply({ op: 'op.begun', opToken: `admission-${admissions}` });
            return;
          }
          if (request.op !== 'readiness.wait') return;
          requests.push(request);
          if (requests.length === 1) reply({ op: 'readiness.changed', revision: 9, coverage: 'covered' });
          else if (requests.length === 2) {
            admission?.end();
            socket.end();
          } else if (requests.length === 3) reply({ op: 'readiness.changed', revision: 0, gone: true });
          else reply({ op: 'readiness.changed', revision: 2, coverage: 'covered' });
        },
        async (root) => {
          const sockets: Socket[] = [];
          await ensureStimd(process.env, process.platform, true, sockets, 'stim ios');
          const operation = testContext({ cwd: root, projectRoot: root });
          operationState(operation).stimdOpToken = admittedOpToken(sockets);
          assert.equal(operationState(operation).stimdOpToken, 'admission-1');
          const wait = deviceLogReadinessWait(root, 'ios', 'default', 'stream', 1, operation);
          wait.coverThrough(25);
          await wait(1500);
          assert.equal(wait.coverage(), 'covered');
          await wait(2000);
          return wait.coverage();
        },
      );
      expect(admissions).toBe(2);
      expect(coverage).toBe(outcome === 'resumed' ? 'covered' : 'failed');
      const successorWait = {
        opToken: 'admission-2',
        params: expect.objectContaining({ after: 0, checkCoverage: true, through: 25, streamId: 'stream' }),
      };
      expect(requests.slice(1).map(({ opToken, params }) => ({ opToken, params }))).toEqual([
        { opToken: 'admission-1', params: expect.objectContaining({ after: 9, checkCoverage: false, through: 25 }) },
        ...(outcome === 'resumed' ? [successorWait, successorWait] : []),
      ]);
    },
  );
});

async function readinessAfterLoss(
  respond: (request: Record<string, unknown>, socket: Socket, reply: (message: object) => void) => void,
  run: (wait: ReturnType<typeof deviceLogReadinessWait>) => Promise<void>,
): Promise<string> {
  return withSocketPeer(respond, async (root) => {
    const sockets: Socket[] = [];
    await ensureStimd(process.env, process.platform, true, sockets, 'stim ios');
    const operation = testContext({ cwd: root, projectRoot: root });
    operationState(operation).stimdOpToken = admittedOpToken(sockets);
    const wait = deviceLogReadinessWait(root, 'ios', 'default', 'stream', 1, operation);
    wait.coverThrough(25);
    try {
      await run(wait);
    } finally {
      wait.close();
    }
    return wait.coverage();
  });
}

describe.skipIf(process.platform === 'win32')('readiness after a lost daemon connection, across polls', () => {
  test('overlapping polls share one readmission and one successor request', async () => {
    let first: Socket | undefined;
    let admissions = 0;
    const requests: Record<string, unknown>[] = [];
    const coverage = await readinessAfterLoss(
      (request, socket, reply) => {
        if (request.op === 'op.begin') {
          admissions++;
          if (admissions === 1) first = socket;
          reply({ op: 'op.begun', opToken: `admission-${admissions}` });
        } else if (request.op === 'readiness.wait') {
          requests.push(request);
          if (requests.length === 1) {
            first?.end();
            socket.end();
          } else {
            const answer = requests.length === 2 ? 'covered' : 'failed';
            setTimeout(() => reply({ op: 'readiness.changed', revision: 2, coverage: answer }), 300);
          }
        }
      },
      async (wait) => {
        await Promise.all([wait(1500), wait(1500)]);
      },
    );
    expect(requests.map((request) => request.opToken)).toEqual(['admission-1', 'admission-2']);
    expect(coverage).toBe('covered');
  });

  test.each(['late', 'gone first'] as const)(
    'a successor admitted after the poll ended still proves coverage when its answer is %s',
    async (successor) => {
      let first: Socket | undefined;
      let admissions = 0;
      let successorAsks = 0;
      const seen: string[] = [];
      const coverage = await readinessAfterLoss(
        (request, socket, reply) => {
          if (request.op === 'op.begin') {
            admissions++;
            if (admissions === 1) {
              first = socket;
              reply({ op: 'op.begun', opToken: 'admission-1' });
            } else setTimeout(() => reply({ op: 'op.begun', opToken: 'admission-2' }), 800);
          } else if (request.op === 'readiness.wait') {
            if (request.opToken === 'admission-1') {
              first?.end();
              socket.end();
            } else if (++successorAsks === 1 && successor === 'gone first') {
              reply({ op: 'readiness.changed', revision: 0, gone: true });
            } else setTimeout(() => reply({ op: 'readiness.changed', revision: 3, coverage: 'covered' }), 1700);
          }
        },
        async (wait) => {
          for (let poll = 0; poll < 20; poll++) {
            await wait(500);
            seen.push(wait.coverage());
            if (wait.coverage() === 'covered') break;
          }
        },
      );
      expect(coverage).toBe('covered');
      expect(seen).not.toContain('failed');
      expect(successorAsks).toBe(successor === 'late' ? 1 : 2);
    },
  );
});

describe.skipIf(process.platform === 'win32')('local requests after a lost daemon connection', () => {
  test.each(['tunnel.ensure', 'logs.start'] as const)(
    '%s repeats the request under the successor admission',
    async (op) => {
      let firstAdmission: Socket | undefined;
      let admissions = 0;
      const requests: Record<string, unknown>[] = [];
      const tunnel = { port: 34567, mode: 'cloudflared', isExpo: false, ngrokUrl: null };
      const stream = { platform: 'android' as const, slot: 'qa', serial: 'emulator-5554', packageName: 'test.app' };
      const answer =
        op === 'tunnel.ensure'
          ? { op: 'tunnel', provider: 'cloudflared', url: 'https://successor.example.test' }
          : { op: 'logs.started', streamId: 'successor-stream' };

      await withSocketPeer(
        (request, socket, reply) => {
          if (request.op === 'op.begin') {
            admissions++;
            if (admissions === 1) firstAdmission = socket;
            reply({ op: 'op.begun', opToken: `admission-${admissions}` });
          } else if (request.op === op) {
            requests.push(request);
            if (requests.length === 1) {
              firstAdmission?.end();
              socket.end();
            } else reply(answer);
          }
        },
        async (root) => {
          const sockets: Socket[] = [];
          await ensureStimd(process.env, process.platform, true, sockets, 'stim ios');
          const operation = testContext({ cwd: root, projectRoot: root });
          operationState(operation).stimdOpToken = admittedOpToken(sockets);
          assert.equal(operationState(operation).stimdOpToken, 'admission-1');

          const result =
            op === 'tunnel.ensure'
              ? await ensureTunnelThroughStimd({ root, ...tunnel }, 2000, operation, operation.signal)
              : await startDeviceLogStream({ root, ...stream }, operation);
          expect(result).toEqual(op === 'tunnel.ensure' ? answer : { streamId: 'successor-stream' });
          expect(operationState(operation).stimdOpToken).toBe('admission-2');
          const params = op === 'tunnel.ensure' ? { root, ...tunnel, requireReachable: false } : { root, ...stream };
          expect(requests).toEqual([
            { op, opToken: 'admission-1', params },
            { op, opToken: 'admission-2', params },
          ]);
          expect(admissions).toBe(2);
        },
      );
    },
  );
});
