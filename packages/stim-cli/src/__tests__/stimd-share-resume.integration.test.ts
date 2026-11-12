import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  loadConfig,
  readLiveShareLinks,
  shareRouteClaimRoot,
  stimdRecordFile,
  workspaceMetadataFile,
  workspaceShareLinksFile,
} from '@stim-cli/core/state';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { stimdConnect, terminateClients } from '../../../server/__tests__/noise-client.ts';

const root = join(import.meta.dirname, '../../../..');
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

/** A scratch home with proxy exposure, one registered workspace and a fake `tailscale` first on PATH. */
async function scratchHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-share-resume-')));
  process.env.STIM_HOME = home;
  const workspace = join(home, 'app');
  mkdirSync(workspace);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      projects: { [workspace]: {} },
      share: { exposure: 'proxy', publicUrl: 'https://demo.example.com', port },
    }),
  );
  const bin = join(home, 'bin');
  const calls = join(home, 'tailscale-calls.txt');
  mkdirSync(bin);
  const running = '{"BackendState":"Running","Self":{"DNSName":"mac.tail.ts.net."}}';
  writeFileSync(
    join(bin, 'tailscale'),
    `#!/bin/sh\necho "$@" >> ${calls}\nif [ "$1" = status ]; then echo '${running}'; else echo '{}'; fi\n`,
  );
  chmodSync(join(bin, 'tailscale'), 0o755);
  const env = {
    ...process.env,
    STIM_HOME: home,
    HOME: home,
    USERPROFILE: home,
    PATH: [bin, dirname(process.execPath)].join(delimiter),
  };
  mkdirSync(dirname(workspaceMetadataFile(workspace)), { recursive: true });
  writeFileSync(workspaceMetadataFile(workspace), JSON.stringify({ projectRoot: workspace }));
  const setExposure = (exposure: string) =>
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        projects: { [workspace]: {} },
        share: { exposure, publicUrl: 'https://demo.example.com', port },
      }),
    );
  const save = (links: Record<string, unknown>) =>
    writeFileSync(workspaceShareLinksFile(workspace), JSON.stringify({ version: 1, links }));
  return { home, workspace, env, save, setExposure, calls, port };
}

const link = (over: Record<string, unknown> = {}) => ({
  platform: 'ios',
  slot: 'default',
  physical: false,
  control: false,
  token: TOKEN,
  origin: 'https://demo.example.com/s/',
  password: 'saved-password',
  auth: 'generated',
  viewAuth: null,
  state: 'live',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  ...over,
});

let home = '';
let previousHome: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  previousHome = process.env.STIM_HOME;
});

afterEach(() => {
  terminateClients();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (previousHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = '';
});

/** Starts a stimd for the home and resolves with its CLI socket once it records itself. */
async function startStimd(env: NodeJS.ProcessEnv, previousPid?: number) {
  const child = spawn(process.execPath, [join(root, 'packages/stim-cli/dist/cli.mjs'), '__stimd', '--mode', 'off'], {
    env,
    stdio: 'ignore',
  });
  children.push(child);
  const exited = once(child, 'exit');
  const recorded = (): { pid?: number; socket?: string } | null => {
    try {
      return JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
    } catch {
      return null;
    }
  };
  await vi.waitFor(
    () => {
      if (child.exitCode !== null) throw new Error('stimd exited before it recorded itself');
      const record = recorded();
      expect(record?.pid === child.pid && record?.pid !== previousPid).toBe(true);
    },
    { timeout: 15_000, interval: 50 },
  );
  return { child, exited, socket: String(recorded()?.socket) };
}

/** The shares the home's net thread serves, read through stimd's CLI socket; empty while no net thread listens. */
async function servedShares(socket: string): Promise<Array<{ expiresAt: string }>> {
  try {
    const client = await stimdConnect(socket);
    await client.request('hello', { client: { name: 'stim', version: '0.0.0' } });
    const reply = await client.request('share.list');
    client.socket.terminate();
    return JSON.parse(JSON.stringify(reply)).result.shares;
  } catch {
    return [];
  }
}

test('a share-only share survives a handover and a crash with the same link and expiry, and an expired one is not restored', async () => {
  const scratch = await scratchHome();
  home = scratch.home;
  expect(loadConfig()?.share?.exposure).toBe('proxy');
  const live = link();
  scratch.save({
    ios: live,
    'ios@old': link({
      slot: 'old',
      token: 'B'.repeat(43),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  });
  const linkStatus = async (token: string) => (await fetch(`http://127.0.0.1:${scratch.port}/s/${token}/`)).status;
  const restored = async (socket: string) => {
    await vi.waitFor(async () => expect(await servedShares(socket)).toHaveLength(1), { timeout: 20_000 });
    const [share] = await servedShares(socket);
    expect(await linkStatus(TOKEN)).toBe(200);
    expect(await linkStatus('B'.repeat(43))).toBe(404);
    expect(Date.parse(share?.expiresAt ?? '')).toBe(Date.parse(live.expiresAt));
  };

  const first = await startStimd(scratch.env);
  await restored(first.socket);

  first.child.kill('SIGTERM');
  await first.exited;
  expect(readLiveShareLinks().map(({ share }) => [share.token, share.expiresAt])).toEqual([[TOKEN, live.expiresAt]]);

  const second = await startStimd(scratch.env, first.child.pid);
  await restored(second.socket);

  second.child.kill('SIGKILL');
  await second.exited;
  const third = await startStimd(scratch.env, second.child.pid);
  await restored(third.socket);

  third.child.kill('SIGTERM');
  await third.exited;
  expect(existsSync(scratch.calls) ? readFileSync(scratch.calls, 'utf8') : '').not.toMatch(/funnel|serve/);
}, 90_000);

test('a stimd with no saved share and no share route left starts no net thread', async () => {
  const scratch = await scratchHome();
  home = scratch.home;
  scratch.save({ ios: link({ state: 'stopped' }) });
  const stimd = await startStimd(scratch.env);
  await vi.waitFor(
    () => expect(readFileSync(join(home, 'daemon', 'daemon.ndjson'), 'utf8')).toContain('daemon_started'),
    {
      timeout: 20_000,
    },
  );
  await expect(stimdConnect(stimd.socket)).rejects.toThrow(/net-off/);
  stimd.child.kill('SIGTERM');
  await stimd.exited;
}, 60_000);

test('a stimd that starts after a crash removes the share route claim the dead one left', async () => {
  const scratch = await scratchHome();
  home = scratch.home;
  const crashed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { tryAcquireClaim } from '@stim-cli/core/ownership-claim';
tryAcquireClaim({ root: ${JSON.stringify(shareRouteClaimRoot())}, mode: 'exclusive', details: { funnelPort: 10000, target: 51234, dnsName: 'mac.tail.ts.net' } });`,
    ],
    {
      cwd: join(root, 'packages/stim-cli'),
      env: scratch.env,
      encoding: 'utf8',
    },
  );
  expect(crashed.status).toBe(0);
  expect(readClaimSet(shareRouteClaimRoot()).dead).toHaveLength(1);
  const stimd = await startStimd(scratch.env);
  await vi.waitFor(() => expect(existsSync(shareRouteClaimRoot())).toBe(false), { timeout: 20_000 });
  expect(readFileSync(scratch.calls, 'utf8')).toContain('serve status');
  stimd.child.kill('SIGTERM');
  await stimd.exited;
}, 60_000);

test('a saved share is left stopped, and no funnel or serve command runs, when Funnel exposure is chosen after it was shared under proxy', async () => {
  const scratch = await scratchHome();
  home = scratch.home;
  scratch.setExposure('tailscale');
  expect(loadConfig()?.share?.exposure).toBe('tailscale');
  expect(scratch.env.PATH.startsWith(join(home, 'bin'))).toBe(true);
  scratch.save({ ios: link() });
  const stimd = await startStimd(scratch.env);
  await vi.waitFor(() => expect(readLiveShareLinks()).toEqual([]), { timeout: 20_000 });
  expect(JSON.parse(readFileSync(workspaceShareLinksFile(scratch.workspace), 'utf8')).links.ios.state).toBe('stopped');
  expect(await servedShares(stimd.socket)).toEqual([]);
  expect(existsSync(scratch.calls) ? readFileSync(scratch.calls, 'utf8') : '').not.toMatch(/^(funnel|serve)/m);
  stimd.child.kill('SIGTERM');
  await stimd.exited;
}, 60_000);
