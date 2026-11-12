import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { captureProcessToken, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identity from '../process-identity.ts';
import * as metro from '../metro.ts';
import { upsertProject } from '../workspace/config.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import {
  adoptMetroChildren,
  closeMetroChildren,
  ensureMetro,
  stopManagedTunnel,
  metroTick,
  openMetroChildren,
} from '../stimd/metro/children.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';
import { injectedDigest } from '../stimd/metro/injected.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { stopForeignSupervisors } from '../stimd/foreign-supervisors.ts';

async function stopFixture(pid: number, token: string): Promise<void> {
  const status = inspectProcessIdentity({ pid, processToken: token });
  if (status === 'unknown') throw new Error(`fixture child ${pid} could not be verified`);
  if (status === 'same') {
    metro.signalProcessTree(pid, 'SIGKILL', { group: true });
    if (!(await waitForProcessExit({ pid, processToken: token }, 2000)))
      throw new Error(`fixture child ${pid} did not stop`);
  }
}

describe.skipIf(process.platform === 'win32')('adopted Metro identity', () => {
  test.each(['gone', 'different', 'unknown'] as const)(
    'an adopted Metro group with %s leader identity is not signalled',
    async (status) => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-adopt-identity-')));
      vi.stubEnv('STIM_HOME', home);
      const root = join(home, 'project');
      mkdirSync(root);
      upsertProject(root, { metroPort: 8181 });
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      await once(child, 'spawn');
      child.unref();
      const pid = child.pid;
      if (!pid) throw new Error('fixture child did not start');
      const token = captureProcessToken(pid);
      if (!token) {
        child.kill('SIGKILL');
        throw new Error('fixture child identity unavailable');
      }
      const original = inspectProcessIdentity;
      const claimRoot = join(workspaceDir(root), 'metro.claim');
      plantClaim(claimRoot, 'exclusive', goneClaimOwner(), {
        details: { port: 8181, mode: 'command' },
        child: { record: { pid, processToken: token } },
      });
      openMetroChildren();
      try {
        adoptMetroChildren(() => {});
        const inspect = vi
          .spyOn(identity, 'inspectProcessIdentity')
          .mockImplementation((record) => (record?.pid === pid ? status : original(record)));
        try {
          const answer = await ensureMetro({ root, port: 8182 }, () => {});
          expect(answer).toMatchObject({ op: 'error', code: 'STIM_CLAIM_UNAVAILABLE' });
          expect(original({ pid, processToken: token })).toBe('same');
          expect(readClaimSet(claimRoot).live).toMatchObject([
            { childDeclared: true, child: { pid, processToken: token } },
          ]);
          await expect(closeMetroChildren()).rejects.toMatchObject({ reportCleanup: true });
        } finally {
          inspect.mockRestore();
        }
      } finally {
        await stopFixture(pid, token);
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.each(['before TERM', 'before KILL'])(
    'a tunnel identity change %s prevents that group signal',
    async (when) => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-tunnel-identity-')));
      vi.stubEnv('STIM_HOME', home);
      const root = join(home, 'project');
      mkdirSync(root);
      upsertProject(root, {});
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      await once(child, 'spawn');
      child.unref();
      const pid = child.pid;
      if (!pid) throw new Error('fixture child did not start');
      const token = captureProcessToken(pid);
      if (!token) {
        child.kill('SIGKILL');
        throw new Error('fixture child identity unavailable');
      }
      const original = inspectProcessIdentity;
      const claimRoot = join(workspaceDir(root), 'tunnel.claim');
      plantClaim(claimRoot, 'exclusive', goneClaimOwner(), {
        details: { port: 8181, provider: 'cloudflared', url: 'https://example.test' },
        child: { record: { pid, processToken: token } },
      });
      openMetroChildren();
      try {
        adoptMetroChildren(() => {});
        let checks = 0;
        const inspect = vi.spyOn(identity, 'inspectProcessIdentity').mockImplementation((record) => {
          if (record?.pid !== pid) return original(record);
          checks++;
          return checks <= (when === 'before TERM' ? 1 : 2) ? 'same' : 'different';
        });
        const signal = vi.spyOn(metro, 'signalProcessTree').mockReturnValue(true);
        vi.useFakeTimers();
        try {
          const stopping = stopManagedTunnel({ root, pid, processToken: token }, () => {});
          await vi.advanceTimersByTimeAsync(5100);
          await expect(stopping).resolves.toMatchObject({ op: 'error', code: 'STIM_CLAIM_UNAVAILABLE' });
          expect(signal).toHaveBeenCalledTimes(when === 'before TERM' ? 0 : 1);
          expect(original({ pid, processToken: token })).toBe('same');
          expect(readClaimSet(claimRoot).live).toMatchObject([
            { childDeclared: true, child: { pid, processToken: token } },
          ]);
        } finally {
          vi.useRealTimers();
          signal.mockRestore();
          inspect.mockRestore();
        }
      } finally {
        await stopFixture(pid, token);
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.each([
    [false, 'keeps'],
    [true, 'stops'],
  ])(
    'with requests observable: %s, the off-mode tick %s an Expo dev server idle past idle.minutes',
    async (observesRequests, outcome) => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-idle-')));
      vi.stubEnv('STIM_HOME', home);
      const root = join(home, 'project');
      mkdirSync(root);
      writeFileSync(join(root, '.stim.json'), JSON.stringify({ idle: { minutes: 1 } }));
      upsertProject(root, { metroPort: 8183 });
      ensureWorkspaceStorage(root);
      mkdirSync(workspaceLogsDir(root), { recursive: true });
      const longAgo = Date.now() - 10 * 60_000;
      writeFileSync(
        join(workspaceLogsDir(root), 'metro.ndjson'),
        `${JSON.stringify({ ts: longAgo, src: 'metro', event: 'supervisor_started' })}\n`,
      );
      writeWorkspaceState(root, { lastUsedAt: new Date(longAgo).toISOString() });
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      await once(child, 'spawn');
      child.unref();
      const pid = child.pid;
      if (!pid) throw new Error('fixture child did not start');
      const token = captureProcessToken(pid);
      if (!token) {
        child.kill('SIGKILL');
        throw new Error('fixture child identity unavailable');
      }
      plantClaim(join(workspaceDir(root), 'metro.claim'), 'exclusive', goneClaimOwner(), {
        details: {
          port: 8183,
          mode: 'expo-child',
          digest: injectedDigest(),
          ...(observesRequests ? { observesRequests } : {}),
        },
        startedAt: new Date(longAgo).toISOString(),
        child: { record: { pid, processToken: token } },
      });
      openMetroChildren();
      try {
        await metroTick('off', () => {});
        expect(inspectProcessIdentity({ pid, processToken: token })).toBe(outcome === 'keeps' ? 'same' : 'gone');
        await closeMetroChildren();
      } finally {
        await stopFixture(pid, token);
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test('an adopted Metro that exits has the watchman roots it registered removed', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-roots-')));
    vi.stubEnv('STIM_HOME', home);
    const root = join(home, 'project');
    mkdirSync(root);
    upsertProject(root, { metroPort: 8184 });
    const calls: string[][] = [];
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file !== 'watchman') return real.runFileAsync(file, args, options);
        calls.push(args);
        if (args.includes('debug-get-subscriptions')) return '{"subscribers":[]}';
        if (args.includes('trigger-list')) return '{"triggers":[]}';
        return args.includes('watch-list') ? '{"roots":[]}' : '{}';
      },
    });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await once(child, 'spawn');
    child.unref();
    const pid = child.pid;
    if (!pid) throw new Error('fixture child did not start');
    const token = captureProcessToken(pid);
    if (!token) {
      child.kill('SIGKILL');
      throw new Error('fixture child identity unavailable');
    }
    plantClaim(join(workspaceDir(root), 'metro.claim'), 'exclusive', goneClaimOwner(), {
      details: {
        port: 8184,
        mode: 'command',
        digest: injectedDigest(),
        watch: { before: [], owned: [root] },
      },
      child: { record: { pid, processToken: token } },
    });
    openMetroChildren();
    try {
      adoptMetroChildren(() => {});
      await stopFixture(pid, token);
      await vi.waitFor(async () => {
        await metroTick('on', () => {});
        expect(calls).toContainEqual(['--no-spawn', 'watch-del', root]);
      });
      await closeMetroChildren();
    } finally {
      await stopFixture(pid, token);
      resetExecutor();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test.each([
    ['it adopted', goneClaimOwner],
    ['its predecessor still holds', liveClaimOwner],
  ])(
    'after an engine switch the successor does not stop a Metro %s as a foreign supervisor',
    async (_, owner) => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-adopted-foreign-')));
      vi.stubEnv('STIM_HOME', home);
      const root = join(home, 'project');
      mkdirSync(root);
      upsertProject(root, { metroPort: 8185 });
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      await once(child, 'spawn');
      child.unref();
      const pid = child.pid;
      if (!pid) throw new Error('fixture child did not start');
      const token = captureProcessToken(pid);
      if (!token) {
        child.kill('SIGKILL');
        throw new Error('fixture child identity unavailable');
      }
      plantClaim(join(workspaceDir(root), 'metro.claim'), 'exclusive', owner(), {
        details: { port: 8185, mode: 'command', digest: injectedDigest(), engineDir: 'previous-build' },
        child: { record: { pid, processToken: token } },
      });
      writeWorkspaceState(root, {
        supervisor: { pid, processToken: token, engineDir: 'previous-build', port: 8185, mode: 'command' },
      });
      openMetroChildren();
      try {
        adoptMetroChildren(() => {});
        expect(await stopForeignSupervisors('next-build', Date.now() + 60 * 60_000)).toBe(0);
        await new Promise((done) => setTimeout(done, 300));
        expect(inspectProcessIdentity({ pid, processToken: token })).toBe('same');
        await closeMetroChildren();
      } finally {
        await stopFixture(pid, token);
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
