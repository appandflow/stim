import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStreamClaim } from '../stimd/logs/claim.ts';
import { registerCollector, unregisterStreamAll } from '../stimd/logs/state.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

test.skipIf(process.platform === 'win32')(
  'removing the inspected pending child marker enables normal stream recovery',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim claim remedy '));
    const root = mkdtempSync(join(tmpdir(), 'stim claim workspace '));
    vi.stubEnv('STIM_HOME', home);
    const claimModule = new URL('../stimd/logs/claim.ts', import.meta.url).href;
    const ownershipModule = new URL('../ownership-claim.ts', import.meta.url).href;
    const script = `import { takeStreamClaim } from ${JSON.stringify(claimModule)};
import { markClaimChildPending } from ${JSON.stringify(ownershipModule)};
const claim = await takeStreamClaim(${JSON.stringify(root)}, 'stream');
markClaimChildPending(claim);`;
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
      { env: process.env, stdio: 'ignore' },
    );
    try {
      expect((await once(child, 'exit'))[0]).toBe(0);
      registerCollector(root, 'ios', { kind: 'stream', streamId: 'stream', startedAt: new Date().toISOString() });
      let message = '';
      try {
        await clearStreamClaim(root, 'stream', () => unregisterStreamAll(root, 'stream'));
      } catch (error) {
        message = String(error);
      }
      const command = /run (rm -f .+) and retry/.exec(message)?.[1];
      expect(command).toBeDefined();
      if (!command) throw new Error('no marker remedy');
      execFileSync('/bin/sh', ['-c', command]);
      await clearStreamClaim(root, 'stream', () => unregisterStreamAll(root, 'stream'));
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
