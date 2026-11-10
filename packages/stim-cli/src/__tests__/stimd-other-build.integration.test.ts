import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';

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
