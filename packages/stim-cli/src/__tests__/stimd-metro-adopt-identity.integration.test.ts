import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { captureProcessToken, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identity from '../process-identity.ts';
import * as metro from '../metro.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceDir } from '../workspace/paths.ts';
import {
  adoptMetroChildren,
  closeMetroChildren,
  ensureMetro,
  ensureTunnel,
  openMetroChildren,
} from '../stimd/metro/children.ts';
import { goneClaimOwner, plantClaim } from './_factories.ts';

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
          expect(readClaimSet(claimRoot).live).toMatchObject([{ childDeclared: true, child: null }]);
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
          const stopping = ensureTunnel({ root, port: 8182, provider: 'cloudflared' });
          await vi.advanceTimersByTimeAsync(5100);
          await expect(stopping).resolves.toMatchObject({ op: 'error', code: 'STIM_CLAIM_UNAVAILABLE' });
          expect(signal).toHaveBeenCalledTimes(when === 'before TERM' ? 0 : 1);
          expect(original({ pid, processToken: token })).toBe('same');
          expect(readClaimSet(claimRoot).live).toMatchObject([{ childDeclared: true, child: null }]);
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
});
