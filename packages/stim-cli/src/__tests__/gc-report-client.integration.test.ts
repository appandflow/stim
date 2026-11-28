import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stimdClaimRoot } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { readGcReportThroughStimd } from '../daemon/client.ts';
import { serveStimdSocket } from './_stimd-socket.ts';

test.skipIf(process.platform === 'win32')(
  'a background gc report ask to a stimd that never answers gives up, so a cached dry run exits',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-gc-report-client-'));
    vi.stubEnv('STIM_HOME', home);
    const claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'shared', label: 'stimd' }).acquired;
    onTestFinished(() => {
      releaseClaim(claim);
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });
    await serveStimdSocket(null);
    await expect(readGcReportThroughStimd({ background: true })).resolves.toBeNull();
  },
);
