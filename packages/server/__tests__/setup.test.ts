import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { readSetupJournal, type SetupCapability, type SetupJournal } from '@stim-cli/core/state';
import type { PairedDevice } from '../src/registry.ts';
import { writeSetupJournal, pruneSetupJournals } from '../src/setup-journal.ts';
import {
  confirmSetup,
  defaultSetupDeps,
  discardTypedAhead,
  parseSetupArgs,
  runSetup,
  selectGrants,
  setupClaim,
  setupExitCode,
  setupVersionDecision,
  type SetupDeps,
} from '../src/setup.ts';
import { findTailscale, tailscaleInstall } from '@stim-cli/transport-tailscale';
import type { InstalledService } from '../src/service-plist.ts';

const now = Date.parse('2026-10-06T12:00:00Z');
const ticketBytes = Buffer.alloc(32, 7);
const ticket = ticketBytes.toString('base64url');
const args = ['--expires', '2026-10-06T12:30:00Z', '--build'];
const options = parseSetupArgs(args, now, ticket);
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-setup-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function record(capability: SetupCapability, overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: capability === 'build' ? 'build-id' : 'host-id',
    name: 'Client machine',
    publicKey: 'client-key',
    pairedAt: new Date(now).toISOString(),
    lastSeenAt: null,
    capabilities: [capability],
    setupJournal: options.journal,
    ...overrides,
  };
}

const health =
  (host: { screenRecording: boolean; accessibility: boolean }): SetupDeps['health'] =>
  async () => ({
    version: '1.16.0',
    stim: '1.16.0',
    stimHome: home,
    protocol: 2,
    stimBuild: 'digest',
    host: { name: 'Stim Host', ...host },
  });

function fixture(overrides: Partial<SetupDeps> = {}) {
  let time = now;
  let installClaim = false;
  let version = '1.16.0';
  const records: PairedDevice[] = [];
  const client = { spends: true };
  const stored: SetupCapability[][] = [];
  let secretLive = false;
  const snapshots: SetupJournal[] = [];
  const stdout: string[] = [],
    stderr: string[] = [];
  const actions: string[] = [];
  const installed: InstalledService = {
    label: 'dev.stim.server',
    host: '/Stim Host.app/Contents/MacOS/stim-host',
    node: '/node',
    script: '/server.mjs',
    port: 7787,
    env: [],
    pathPrepend: [],
    stimHome: home,
    logPath: '/log',
    managed: true,
    serve: { port: 7447, created: false },
    previousScript: null,
    programArguments: [],
  };
  const deps: SetupDeps = {
    platform: 'darwin',
    ticket,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    tty: false,
    stdout: (line) => {
      stdout.push(line);
    },
    stderr: (line) => {
      stderr.push(line);
    },
    confirm: async () => false,
    permissionWait: async (ms) => {
      time += ms;
      return false;
    },
    preflight: async () => ({ dnsName: 'worker.ts.net' }),
    fingerprint: () => 'server-fingerprint',
    firewall: async () => null,
    claim: setupClaim,
    write: (hash, journal) => {
      writeSetupJournal(hash, journal);
      snapshots.push(structuredClone(journal));
    },
    prune: pruneSetupJournals,
    withInstallClaim: async (_label, work) => {
      installClaim = true;
      try {
        return await work();
      } finally {
        installClaim = false;
      }
    },
    installed: async () => installed,
    health: async () => ({
      version,
      stim: '1.16.0',
      stimHome: home,
      protocol: 2,
      stimBuild: 'digest',
      host: { name: 'Stim Host', screenRecording: true, accessibility: true },
    }),
    build: () => ({ version, stimBuild: 'digest' }),
    install: async (_versions, source) => {
      expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'server')?.state).toBe('running');
      expect(source).toEqual({ release: '1.16.0' });
      actions.push('install');
      return { script: '/server.mjs', build: { version: '1.16.0', stimBuild: 'digest' }, dir: '/versions' };
    },
    update: async () => {
      actions.push('update');
      version = '1.16.0';
      return ['Updated'];
    },
    installHost: async () => {
      actions.push('host');
      return {
        app: '/Stim Host.app',
        executable: '/Stim Host.app/Contents/MacOS/stim-host',
        name: 'Stim Host',
        bundleId: 'dev.stim.host',
        replaced: false,
        adHoc: false,
      };
    },
    installJob: async (_opts, setup) => {
      expect(installClaim).toBe(true);
      expect(setup?.requestPermissions).toBe(false);
      actions.push('service');
      return [];
    },
    route: async () => ({ state: 'routed', port: 7447 }),
    prepareRoute: async () => ({ record: { port: 7447, created: false }, create: null }),
    recordRoute: async () => {},
    createRoute: async () => {
      actions.push('route');
    },
    watchRecords: () => () => {},
    records: () => {
      expect(installClaim).toBe(false);
      return records;
    },
    storeSecret: (secret, capabilities, expiresAt) => {
      expect(secret.equals(ticketBytes)).toBe(true);
      expect(expiresAt).toBe(options.expiresAt);
      stored.push(capabilities);
      secretLive = true;
      if (client.spends) records.push(...capabilities.map((c) => record(c)));
    },
    dropSecret: (journal) => {
      expect(journal).toBe(options.journal);
      secretLive = false;
    },
    panes: async () => ({ screen: 'Screen & System Audio Recording', control: 'Device Control and Data Access' }),
    requestPermissions: async () => {
      actions.push('permissions');
    },
    openPane: async (pane) => {
      actions.push(pane);
    },
    toolchain: async () => ({
      stimBuild: 'digest',
      arch: 'arm64',
      xcode: '27',
      simulatorSdk: '27',
      macosSdk: '27',
      cocoapods: '1.16',
      runtimes: ['iOS-27'],
      jdk: '17',
      androidSdk: { ndk: ['27'], buildTools: ['36'], platforms: ['36'] },
    }),
    node: '/node',
    versions: () => '/versions',
    stimBuild: 'digest',
    ...overrides,
  };
  return { deps, records, client, stored, secretLive: () => secretLive, stdout, stderr, actions, snapshots };
}

test.each([
  ['another setup run', { setupJournal: 'other' }],
  ['a record paired without setup', { setupJournal: undefined }],
  ['a record for the other capability', { capabilities: ['device-host'] }],
] satisfies [string, Partial<PairedDevice>][])("selector does not report %s as this run's grant", (_name, fields) => {
  expect(selectGrants([record('build', fields)], options)).toEqual([]);
});

test.each([
  ['no capability', args.slice(0, -1)],
  ['ticket on the command line', [...args, '--ticket', ticket]],
  ['expired', args.map((a) => (a === options.expiresAt ? '2026-10-06T11:00:00Z' : a))],
  ['too far ahead', args.map((a) => (a === options.expiresAt ? '2026-10-06T14:00:01Z' : a))],
  ['not ISO', args.map((a) => (a === options.expiresAt ? 'October 6, 2026' : a))],
  ['invalid date', args.map((a) => (a === options.expiresAt ? '2026-02-30T12:30:00Z' : a))],
  ['bad port', [...args, '--port', '0']],
  ['bad label', [...args, '--label', '../label']],
  ['bad environment', [...args, '--env', 'STIM_HOME=/other']],
  ['bad path', [...args, '--path-prepend', 'relative']],
  ['SSH', [...args, '--ssh']],
  ['--client', [...args, '--client', 'nClient']],
])('argument refusal (%s) leaves the Stim home empty', async (name, invalid) => {
  const f = fixture({
    preflight: async () => {
      throw new Error('Preflight must not run');
    },
  });
  expect(await runSetup([...invalid, '--json'], '1.16.0', f.deps)).toBe(name === 'expired' ? 2 : 1);
  expect(readdirSync(home)).toEqual([]);
  expect(f.stdout).toHaveLength(1);
  expect(JSON.parse(f.stdout[0]!).ok).toBe(false);
});

test.each([
  ['missing', undefined],
  ['malformed', 'short'],
])('a %s STIM_SETUP_TICKET is refused before anything runs', async (_name, value) => {
  const f = fixture({
    ticket: value,
    preflight: async () => {
      throw new Error('Preflight must not run');
    },
  });
  expect(await runSetup([...args, '--json'], '1.16.0', f.deps)).toBe(1);
  expect(readdirSync(home)).toEqual([]);
  expect(f.stdout.join('\n')).toContain('STIM_SETUP_TICKET');
});

test('setup refuses a ticket on the command line and names the environment variable instead', () => {
  expect(() => parseSetupArgs([...args, '--ticket', ticket], now, undefined)).toThrow(
    /no longer takes --ticket.*STIM_SETUP_TICKET=<ticket>/,
  );
});

test('preflight refusal has no claim, journal or install effects', async () => {
  const f = fixture({
    preflight: async () => {
      throw new Error('Tailscale is not running');
    },
  });
  expect(await runSetup(args, '1.16.0', f.deps)).toBe(1);
  expect(readdirSync(home)).toEqual([]);
  expect(f.actions).toEqual([]);
});

test('build and device-host are offered through one stored secret and a rerun never offers either again', async () => {
  const f = fixture();
  const both = [...args, '--device-host', '--yes', '--json'];
  expect(await runSetup(both, '1.16.0', f.deps)).toBe(0);
  expect(f.stored).toEqual([['build', 'device-host']]);
  expect(JSON.parse(f.stdout[0]!).granted.map((g: { id: string }) => g.id)).toEqual(['build-id', 'host-id']);
  expect(await runSetup([...args, '--device-host'], '1.16.0', f.deps)).toBe(0);
  expect(f.stored).toHaveLength(1);
  expect(f.stdout.some((line) => line.includes('already approved'))).toBe(true);
});

test('a declined capability is left out of the stored secret', async () => {
  const f = fixture({ tty: true, confirm: async (question) => question.includes('build') });
  expect(await runSetup([...args, '--device-host'], '1.16.0', f.deps)).toBe(1);
  expect(f.stored).toEqual([['build']]);
  expect(readSetupJournal(options.journal)?.granted).toEqual([{ capability: 'build', id: 'build-id' }]);
});

test.each([false, true])(
  'setup waits for its own record and scopes reconnect guidance to Doctor (fromDoctor=%s)',
  async (fromDoctor) => {
    const f = fixture({ fromDoctor });
    f.client.spends = false;
    f.records.push(record('build', { id: 'other-run', setupJournal: 'other' }));
    const sleep = f.deps.sleep;
    let firstWaitOutput: string | undefined;
    f.deps.sleep = async (ms) => {
      firstWaitOutput ??= f.stderr.join('\n');
      await sleep(ms);
      if (f.deps.now() >= now + 5000 && !f.records.some((r) => r.id === 'build-id')) f.records.push(record('build'));
    };
    expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(0);
    expect(JSON.parse(f.stdout[0]!).granted.map((g: { id: string }) => g.id)).toEqual(['build-id']);
    expect(f.stored).toEqual([['build']]);
    expect(f.secretLive()).toBe(false);
    expect(firstWaitOutput?.includes('`stim remote list`')).toBe(fromDoctor);
  },
);

test('while it waits for the requesting machine, setup says so and then confirms the connection', async () => {
  const f = fixture();
  f.client.spends = false;
  const sleep = f.deps.sleep;
  f.deps.sleep = async (ms) => {
    await sleep(ms);
    if (f.deps.now() >= now + 5000 && !f.records.some((r) => r.id === 'build-id')) f.records.push(record('build'));
  };
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(0);
  const waiting = f.stdout.findIndex((line) => line.includes('Stim Desktop sends this automatically'));
  const connected = f.stdout.findIndex((line) => /approved .* for builds/.test(line));
  expect(waiting).toBeGreaterThanOrEqual(0);
  expect(connected).toBeGreaterThan(waiting);
  expect(
    f.snapshots.some((j) =>
      j.steps.some((s) => s.id === 'approve' && s.detail?.startsWith('Waiting for the requesting')),
    ),
  ).toBe(true);
});

test('a requesting machine that never connects still gets the waiting line before the ticket expires', async () => {
  const f = fixture();
  f.client.spends = false;
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(2);
  expect(f.stdout.some((line) => line.includes('Stim Desktop sends this automatically'))).toBe(true);
});

test.each([false, true])(
  'no --yes with tty=%s cannot turn an unanswered or N confirmation into approval',
  async (tty) => {
    const f = fixture({ tty });
    expect(await runSetup(args, '1.16.0', f.deps)).toBe(1);
    expect(f.stored).toEqual([]);
    expect(f.stderr.join('\n')).toContain(tty ? 'build approval refused' : 'rerun with --yes or in a terminal');
    expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'approve.build')?.state).toBe(
      tty ? 'failed' : undefined,
    );
  },
);

test('a setup claim blocks another run and names its exact removal command', async () => {
  const release = setupClaim();
  try {
    const f = fixture();
    expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(1);
    expect(f.actions).toEqual([]);
    expect(f.stderr.join('\n')).toContain('setup.claims');
    expect(f.stderr.join('\n')).toContain('rm -f');
    expect(readSetupJournal(options.journal)).toBeNull();
  } finally {
    release();
  }
});

test.each([
  [null, false, 'install'],
  [{ version: '1.15.0', protocol: 2, running: true }, true, 'update'],
  [{ version: '1.16.0', protocol: 2, running: true }, true, 'reuse'],
  [{ version: '2.0.0', protocol: 2, running: true }, false, 'reuse'],
  [{ version: '1.20.2', protocol: 1, running: true }, false, 'too-old'],
  [{ version: '1.20.2', running: true }, false, 'too-old'],
  [{ version: '1.16.0', running: false }, true, 'reuse'],
  [{ version: '1.16.0-rc.1', protocol: 2, running: true }, true, 'update'],
])(
  'version decision for %j managed=%s updates older managed servers and reuses only protocol 2',
  (current, managed, expected) => {
    expect(setupVersionDecision(current, '1.16.0', managed)).toBe(expected);
  },
);

test.each([
  ['1.16.0-rc.1', '1.16.0-rc.1', 'reuse'],
  ['1.16.0-rc.1', '1.16.0-rc.2', 'update'],
  ['1.16.0-rc.2', '1.16.0-rc.1', 'reuse'],
])('managed RC %s targeting %s retains full version ordering', (current, desired, expected) => {
  expect(setupVersionDecision({ version: current, protocol: 2, running: true }, desired, true)).toBe(expected);
});

const APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

test.each([
  ['the Mac app is present', [APP, '/opt/bin/tailscale'], 'app'],
  ['only a PATH command is present', ['/opt/bin/tailscale'], 'cli'],
  ['no binary is present', [], 'none'],
  ['a tailscale outside PATH is ignored', ['/other/tailscale'], 'none'],
])('Tailscale install when %s', (_name, present, expected) => {
  expect(
    tailscaleInstall({ PATH: ['/usr/bin', '', '/opt/bin'].join(delimiter) }, (path) =>
      present.includes(path.replaceAll('\\', '/')),
    ),
  ).toBe(expected);
});

test.each([
  ['tailscale.exe on PATH', ['/opt/bin/tailscale.exe'], '/opt/bin/tailscale.exe'],
  ['only the default install', ['D:/Apps/Tailscale/tailscale.exe'], 'D:/Apps/Tailscale/tailscale.exe'],
  ['a tailscale without .exe on PATH', ['/opt/bin/tailscale'], null],
])('Windows finds Tailscale with %s', (_name, present, expected) => {
  const env = { PATH: ['/usr/bin', '/opt/bin'].join(delimiter), ProgramFiles: 'D:\\Apps' };
  const found = findTailscale(env, 'win32', (path) => present.includes(path.replaceAll('\\', '/')));
  expect(found?.replaceAll('\\', '/') ?? null).toBe(expected);
});

test('Desktop reuse installs no release or LaunchAgent and refuses an old app before waiting', async () => {
  const f = fixture({ installed: async () => null });
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(0);
  expect(f.actions).toEqual(['host']);
  const old = fixture({
    installed: async () => null,
    health: async () => ({ version: '1.20.2', protocol: 1, stim: '1.20.2', stimHome: home }),
  });
  expect(await runSetup([...args, '--yes'], '1.16.0', old.deps)).toBe(1);
  expect(old.stored).toEqual([]);
  expect(old.actions).toEqual([]);
  const fix = readSetupJournal(options.journal)?.steps.find((s) => s.id === 'server')?.fix;
  expect(fix).toContain('update Stim Desktop');
  expect(fix).toContain('npm install --global @stim-cli/server@1.16.0 and restart the server');
});

test('Funnel refuses before approval and records the off command', async () => {
  const f = fixture({ route: async () => ({ state: 'funneled', port: 7444, ports: [7443] }) });
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(1);
  expect(f.actions).toEqual(['host', 'service']);
  expect(f.stored).toEqual([]);
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'route')).toMatchObject({
    state: 'failed',
    fix: 'tailscale funnel --https=7443 off',
  });
});

test('a worker without Tailscale sets up on the local network, prints its key fingerprint and warns about the firewall', async () => {
  const noRoute = async () => {
    throw new Error('a local network setup must not touch tailscale serve');
  };
  const reused = fixture().deps.health;
  const f = fixture({
    preflight: async () => ({ dnsName: null, lan: true }),
    health: async (port) => {
      const found = await reused(port);
      return found && { ...found, lan: { addresses: ['10.0.0.92'], port: 7787 } };
    },
    firewall: async () => true,
    route: noRoute,
    prepareRoute: noRoute,
    createRoute: noRoute,
  });
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(0);
  const output = JSON.parse(f.stdout.join('\n'));
  expect(output).toMatchObject({
    ok: true,
    route: { state: 'local-network', dnsName: null },
    lan: ['ws://10.0.0.92:7787'],
    fingerprint: 'server-fingerprint',
    granted: [{ capability: 'build', id: 'build-id' }],
  });
  expect(output.warnings).toEqual([expect.stringMatching(/^The macOS firewall is on: when macOS asks whether \/node/)]);
  expect(
    f.snapshots.some((j) =>
      j.steps.some((s) => s.id === 'approve' && s.detail?.includes('server key fingerprint, server-fingerprint')),
    ),
  ).toBe(true);
});

test('a local network setup whose server listens on no local address refuses before storing the ticket', async () => {
  const f = fixture({ preflight: async () => ({ dnsName: null, lan: true }) });
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(1);
  expect(f.stored).toEqual([]);
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'lan')).toMatchObject({
    state: 'failed',
    detail: expect.stringContaining('server.lanAddresses'),
  });
});

test('a worker with Tailscale and a local network listener checks both, so tailnet clients keep their route', async () => {
  const reused = fixture().deps.health;
  const f = fixture({
    preflight: async () => ({ dnsName: 'worker.ts.net', lan: true }),
    health: async (port) => {
      const found = await reused(port);
      return found && { ...found, lan: { addresses: ['10.0.0.92'], port: 7787 } };
    },
  });
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(0);
  expect(JSON.parse(f.stdout.join('\n'))).toMatchObject({
    route: { state: 'routed', dnsName: 'worker.ts.net', port: 7447 },
    lan: ['ws://10.0.0.92:7787'],
  });
  expect(readSetupJournal(options.journal)?.steps.filter((s) => s.id === 'lan' || s.id === 'route')).toEqual([
    expect.objectContaining({ id: 'lan', state: 'ok' }),
    expect.objectContaining({ id: 'route', state: 'ok' }),
  ]);
});

test('journals precede server work, include every completed step, and JSON stdout holds only the final payload', async () => {
  const f = fixture();
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(0);
  expect(f.snapshots[0]?.steps).toEqual([{ id: 'preflight', state: 'ok', title: 'Preflight' }]);
  for (const id of ['server', 'host', 'service', 'route', 'approve', 'tools']) {
    expect(f.snapshots.some((j) => j.steps.some((s) => s.id === id && s.state === 'running'))).toBe(true);
    expect(f.snapshots.some((j) => j.steps.some((s) => s.id === id && s.state === 'ok'))).toBe(true);
  }
  expect(f.stdout).toHaveLength(1);
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({
    ok: true,
    label: 'dev.stim.server',
    port: 7787,
    route: { state: 'routed', dnsName: 'worker.ts.net', port: 7447 },
    server: { version: '1.16.0', stimBuild: 'digest' },
    managed: true,
    granted: [{ capability: 'build', id: 'build-id', client: { name: 'Client machine' } }],
    permissions: { screenRecording: 'not-needed', deviceControl: 'not-needed' },
    warnings: [],
  });
  expect(readSetupJournal(options.journal)).toMatchObject({ done: true, exit: 0 });
});

test('no request before expiry finishes with 2 and never asks for permissions or tools', async () => {
  let closed = false;
  const f = fixture({
    watchRecords: () => () => {
      closed = true;
    },
    toolchain: async () => {
      throw new Error('Must not inspect tools');
    },
  });
  f.client.spends = false;
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(2);
  expect(f.stored).toEqual([['build']]);
  expect(f.secretLive()).toBe(false);
  expect(closed).toBe(true);
});

test('a timed-out permission opens its settings pane, reports the lost feature, and keeps a partial-success journal', async () => {
  const f = fixture({ health: health({ screenRecording: false, accessibility: true }) });
  expect(await runSetup([...args, '--device-host', '--yes'], '1.16.0', f.deps)).toBe(3);
  expect(f.actions.filter((a) => a === 'Privacy_ScreenCapture')).toHaveLength(1);
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'permissions.screenRecording')).toMatchObject({
    state: 'pending',
    detail: 'pending: viewing hosted simulators will not work.',
  });
});

test.each([
  [[], [], 2],
  [[], ['failed'], 1],
  [['build'], [], 3],
  [['build', 'device-host'], ['ok'], 0],
  [['build', 'device-host'], ['pending'], 3],
  [['build', 'device-host'], ['skipped'], 3],
  [['build', 'device-host'], ['failed'], 1],
  [['build', 'device-host'], ['running'], 3],
] satisfies [SetupJournal['capabilities'], SetupJournal['steps'][number]['state'][], number][])(
  'final journal grants=%j states=%j determine exit %s',
  (capabilities, states, expected) => {
    const journal: SetupJournal = {
      v: 1,
      capabilities: ['build', 'device-host'],
      expiresAt: options.expiresAt,
      steps: states.map((state, i) => ({ id: `step-${i}`, title: 'Required check', state })),
      granted: capabilities.map((capability) => ({ capability, id: capability })),
      done: true,
    };
    expect(setupExitCode(journal)).toBe(expected);
  },
);

test('a new worker installs the exact release and records route ownership only after creation', async () => {
  let ready = false;
  let routed = false;
  const events: string[] = [];
  const f = fixture({
    installed: async () => null,
    health: async () =>
      ready ? { version: '1.16.0', protocol: 2, stim: '1.16.0', stimHome: home, stimBuild: 'digest' } : null,
    installJob: async (_opts, setup) => {
      expect(setup?.script).toBe('/server.mjs');
      expect(setup?.requestPermissions).toBe(false);
      events.push('service');
      ready = true;
      return [];
    },
    route: async () => ({ state: routed ? 'routed' : 'missing', port: 7449 }),
    prepareRoute: async () => ({
      record: { port: 7449, created: true },
      create: ['serve', '--bg', '--https=7449', 'http://127.0.0.1:7787'],
    }),
    createRoute: async () => {
      events.push('route');
      routed = true;
    },
    recordRoute: async (_label, _port, routeRecord) => {
      expect(routed).toBe(true);
      expect(routeRecord).toEqual({ port: 7449, created: true });
      events.push('record');
    },
  });
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(0);
  expect(f.actions).toEqual(['install', 'host']);
  expect(events).toEqual(['service', 'route', 'record']);
  expect(JSON.parse(f.stdout[0]!).route.port).toBe(7449);
});

test.each(['linux', 'win32'] as const)(
  'on %s, setup approves builds under its user service without Stim Host or Apple tools',
  async (platform) => {
    const f = fixture({
      platform,
      installed: async () => ({
        label: 'dev.stim.server',
        host: null,
        node: '/node',
        script: '/server.mjs',
        port: 7787,
        env: [],
        pathPrepend: [],
        stimHome: home,
        protocol: 2,
        logPath: '/log',
        managed: true,
        serve: { port: 7447, created: false },
        previousScript: null,
        programArguments: [],
      }),
      installJob: async (_opts, setup) => {
        expect(setup?.host).toBeNull();
        f.actions.push('service');
        return [];
      },
      toolchain: async () => ({
        stimBuild: 'digest',
        arch: 'x64',
        xcode: null,
        simulatorSdk: null,
        macosSdk: null,
        cocoapods: null,
        runtimes: [],
        jdk: '17',
        androidSdk: { ndk: ['27'], buildTools: ['36'], platforms: ['36'] },
      }),
    });
    expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(0);
    expect(f.actions).toEqual(['service']);
    expect(f.stored).toEqual([['build']]);
    const output = JSON.parse(f.stdout.join(''));
    expect(
      output.tools.filter((t: { state: string }) => t.state !== 'present').map((t: { tool: string }) => t.tool),
    ).toEqual(['Xcode', 'iOS runtime', 'CocoaPods']);
    expect(readSetupJournal(options.journal)?.steps.some((s) => s.id === 'host')).toBe(false);
  },
);

test.each([
  ['linux', 'On Linux'],
  ['win32', 'On Windows'],
] as const)('on %s, setup refuses device hosting before preflight', async (platform, where) => {
  const f = fixture({
    platform,
    preflight: async () => {
      throw new Error('Preflight must not run');
    },
  });
  expect(await runSetup([...args, '--device-host', '--json'], '1.16.0', f.deps)).toBe(1);
  expect(f.actions).toEqual([]);
  expect(f.stored).toEqual([]);
  expect(JSON.parse(f.stdout.join('')).warnings.join('\n')).toContain(`Hosting simulators needs a Mac. ${where}, run`);
});

test('a newer managed server stays installed and a different Stim build produces partial success', async () => {
  const f = fixture({
    health: async () => ({ version: '1.17.0', protocol: 2, stim: '1.17.0', stimHome: home, stimBuild: 'new-digest' }),
  });
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(3);
  expect(f.actions).toEqual(['host', 'service']);
  expect(JSON.parse(f.stdout[0]!).server).toEqual({ version: '1.17.0', stimBuild: 'new-digest' });
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'tools.Stim build')?.state).toBe('pending');
});

test.each([false, true])('an older managed server upgrades with the selected idle wait (noWait=%s)', async (noWait) => {
  let upgraded = false;
  const f = fixture({
    health: async () => ({
      version: upgraded ? '1.16.0' : '1.15.0',
      stim: '1.16.0',
      stimHome: home,
      protocol: 2,
      stimBuild: 'digest',
    }),
    update: async (_label, _installed, source, _log, waitForWork) => {
      expect(source).toEqual({ release: '1.16.0' });
      expect(waitForWork).toBe(!noWait);
      upgraded = true;
      return [];
    },
  });
  expect(await runSetup([...args, '--yes', ...(noWait ? ['--no-wait'] : [])], '1.16.0', f.deps)).toBe(0);
  expect(upgraded).toBe(true);
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'server')?.title).toBe('stim-server 1.16.0');
});

test('approval cannot outlive the ticket while a terminal question is open', async () => {
  const f = fixture({ tty: true });
  f.deps.confirm = async (_question, timeout) => {
    await f.deps.sleep(timeout);
    return true;
  };
  expect(await runSetup(args, '1.16.0', f.deps)).toBe(2);
  expect(f.stored).toEqual([]);
});

test('grants the running service already holds are reported without a request or wait', async () => {
  const f = fixture({ tty: true });
  expect(await runSetup([...args, '--device-host', '--yes'], '1.16.0', f.deps)).toBe(0);
  expect(f.actions).not.toContain('permissions');
  const steps = readSetupJournal(options.journal)?.steps ?? [];
  expect(steps.find((s) => s.id === 'permissions.screenRecording')).toMatchObject({
    state: 'ok',
    detail: 'Already granted.',
  });
});

test('terminal permission skip names the unavailable feature without changing TCC or failing the grant', async () => {
  const f = fixture({
    tty: true,
    health: health({ screenRecording: true, accessibility: false }),
    permissionWait: async () => true,
  });
  expect(await runSetup([...args, '--device-host', '--yes', '--json'], '1.16.0', f.deps)).toBe(3);
  expect(JSON.parse(f.stdout[0]!).granted).toHaveLength(2);
  expect(JSON.parse(f.stdout[0]!).permissions).toEqual({ screenRecording: 'granted', deviceControl: 'skipped' });
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'permissions.deviceControl')?.detail).toContain(
    'controlling hosted simulators will not work',
  );
});

test('hosting alone does not require build-only tools or prompt for an existing app permission grant', async () => {
  const f = fixture({
    installed: async () => null,
    health: async () => ({
      version: '1.16.0',
      stim: '1.16.0',
      stimHome: home,
      protocol: 2,
      stimBuild: 'digest',
      host: { name: 'Stim Desktop', screenRecording: true, accessibility: true },
    }),
    toolchain: async () => ({
      stimBuild: 'digest',
      arch: 'arm64',
      xcode: '27',
      simulatorSdk: '27',
      macosSdk: '27',
      cocoapods: null,
      runtimes: ['iOS-27'],
      jdk: null,
      androidSdk: null,
    }),
  });
  expect(await runSetup([...args.slice(0, -1), '--device-host', '--yes', '--json'], '1.16.0', f.deps)).toBe(0);
  expect(f.actions).toEqual(['host']);
  expect(JSON.parse(f.stdout[0]!).tools.filter((t: { state: string }) => t.state === 'missing')).toEqual([]);
});

test('journal write failure stops installation, releases the claim, and still emits one failed JSON result', async () => {
  const f = fixture({
    write: () => {
      throw new Error('disk full');
    },
  });
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(1);
  expect(f.actions).toEqual([]);
  expect(f.stdout).toHaveLength(1);
  expect(JSON.parse(f.stdout[0]!).ok).toBe(false);
  expect(f.stderr.join('\n')).toContain('disk full');
  const release = setupClaim();
  release();
});

test.each(['no record', "another run's record", 'missing capability'])(
  'noninteractive setup with %s refuses before any installation or claim',
  async (kind) => {
    const f = fixture();
    if (kind !== 'no record')
      f.records.push(record('build', kind === 'missing capability' ? {} : { setupJournal: 'other' }));
    expect(await runSetup(kind === 'missing capability' ? [...args, '--device-host'] : args, '1.16.0', f.deps)).toBe(1);
    expect(f.actions).toEqual([]);
    expect(f.stored).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  },
);

test('the later noninteractive guard refuses an approval revoked during installation', async () => {
  const f = fixture();
  f.records.push(record('build'));
  f.deps.installHost = async () => {
    f.records.length = 0;
    return {
      app: '/Stim Host.app',
      executable: '/Stim Host.app/Contents/MacOS/stim-host',
      name: 'Stim Host',
      bundleId: 'dev.stim.host',
      replaced: false,
      adHoc: false,
    };
  };
  expect(await runSetup(args, '1.16.0', f.deps)).toBe(1);
  expect(f.stored).toEqual([]);
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'approve')?.state).toBe('failed');
});

test.each(['verification refusal', 'verification error', 'recording error'])(
  'a created route is removed on %s before ownership is recorded',
  async (failure) => {
    const commands: string[][] = [];
    let routed = false;
    const f = fixture({
      route: async () => {
        if (routed && failure === 'verification error') throw new Error('route lookup failed');
        return { state: routed && failure !== 'verification refusal' ? 'routed' : 'missing', port: 7449 };
      },
      prepareRoute: async () => ({
        record: { port: 7449, created: true },
        create: ['serve', '--bg', '--https=7449', 'http://127.0.0.1:7787'],
      }),
      createRoute: async (command) => {
        commands.push(command);
        routed = command.at(-1) !== 'off';
      },
      recordRoute: async () => {
        throw new Error('route record failed');
      },
    });
    expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(1);
    expect(commands).toEqual([
      ['serve', '--bg', '--https=7449', 'http://127.0.0.1:7787'],
      ['serve', '--https=7449', 'off'],
    ]);
    expect(routed).toBe(false);
    expect(JSON.parse(f.stdout[0]!).route.state).toBe('missing');
    expect(f.stored).toEqual([]);
    expect(readSetupJournal(options.journal)).toMatchObject({ done: true, exit: 1 });
  },
);

test('a route rollback failure records the exact removal remedy', async () => {
  const f = fixture({
    route: async () => ({ state: 'missing', port: 7449 }),
    prepareRoute: async () => ({
      record: { port: 7449, created: true },
      create: ['serve', '--bg', '--https=7449', 'http://127.0.0.1:7787'],
    }),
    createRoute: async (command) => {
      if (command.at(-1) === 'off') throw new Error('tailscale unavailable');
    },
  });
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(1);
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'route')).toMatchObject({
    state: 'failed',
    fix: 'tailscale serve --https=7449 off',
  });
  expect(f.stdout.join('\n')).toContain('tailscale serve --https=7449 off');
});

test('Desktop reuse refuses a new route it cannot record without creating or approving it', async () => {
  const f = fixture({
    installed: async () => null,
    route: async () => ({ state: 'missing', port: 7449 }),
    prepareRoute: async () => ({
      record: { port: 7449, created: true },
      create: ['serve', '--bg', '--https=7449', 'http://127.0.0.1:7787'],
    }),
  });
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(1);
  expect(f.actions).toEqual(['host']);
  expect(f.stored).toEqual([]);
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'route')).toMatchObject({
    state: 'failed',
    fix: 'tailscale serve --bg --https=7449 http://127.0.0.1:7787',
  });
});

test.each(['SIGINT', 'close'] as const)(
  'a readline %s interrupt aborts the question, completes the journal and releases the claim',
  async (event) => {
    const stream = new PassThrough();
    const input = createInterface({ input: stream, output: new PassThrough() });
    const f = fixture({
      tty: true,
      confirm: (question, timeout) => {
        const result = confirmSetup(input, question, timeout);
        setImmediate(() => (event === 'close' ? input.close() : input.emit('SIGINT')));
        return result;
      },
    });
    expect(await runSetup(args, '1.16.0', f.deps)).toBe(1);
    expect(f.stored).toEqual([]);
    expect(readSetupJournal(options.journal)).toMatchObject({ done: true, exit: 1 });
    expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'approve')).toMatchObject({
      state: 'failed',
      detail: 'interrupted',
    });
    const release = setupClaim();
    release();
    stream.destroy();
  },
);

test.each([
  ['', true],
  ['y', true],
  ['YES', true],
  ['n', false],
  ['N', false],
  ['no', false],
  ['maybe', false],
])('a terminal answer %j to the approval question is %s', async (answer, approved) => {
  const stream = new PassThrough();
  const input = createInterface({ input: stream, output: new PassThrough() });
  const result = confirmSetup(input, 'Approve? [Y/n] ', 1000);
  stream.write(`${answer}\n`);
  await expect(result).resolves.toBe(approved);
  stream.destroy();
});

test.each([
  [false, '? [Y/n]'],
  [true, 'on this Mac)? [Y/n]'],
])(
  'the approval question defaults to Yes and names that it runs project code here (concise=%s)',
  async (concise, tail) => {
    const questions: string[] = [];
    const f = fixture({
      tty: true,
      confirm: async (question) => {
        questions.push(question);
        return false;
      },
    });
    const extra = concise ? [] : ['--verbose'];
    expect(await runSetup([...args, ...extra], '1.16.0', f.deps)).toBe(1);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain(tail);
    expect(questions[0]).not.toContain('[y/N]');
    expect(concise ? questions[0] : f.stderr.concat(f.stdout).join('\n')).toContain('runs its');
  },
);

test('an Enter pressed before the question is discarded on a terminal and left alone without one', async () => {
  const tty = Object.assign(new PassThrough(), { isTTY: true });
  tty.write('\n');
  await discardTypedAhead(tty);
  expect(tty.read()).toBeNull();
  const pipe = new PassThrough();
  pipe.write('y\n');
  await discardTypedAhead(pipe);
  expect(pipe.read()?.toString()).toBe('y\n');
});

test('a question timeout returns no answer rather than an interrupt refusal', async () => {
  const input = createInterface({ input: new PassThrough(), output: new PassThrough() });
  await expect(confirmSetup(input, 'Approve? ', 1)).resolves.toBe(false);
});

test.each(['install', 'approval wait', 'tools'])(
  'an injected interrupt during %s fails the running step and finishes without waiting for work',
  async (during) => {
    const controller = new AbortController();
    const interrupt = () => {
      controller.abort();
      return new Promise<never>(() => {});
    };
    let closed = false;
    const f = fixture({
      signal: controller.signal,
      watchRecords: () => () => {
        closed = true;
      },
    });
    const active = during === 'install' ? 'server' : during === 'tools' ? 'tools' : 'approve';
    if (during === 'install') {
      f.deps.installed = async () => null;
      f.deps.health = async () => null;
      f.deps.install = interrupt;
    } else if (during === 'tools') f.deps.toolchain = interrupt;
    else {
      f.client.spends = false;
      f.deps.sleep = interrupt;
    }
    expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(1);
    expect(f.stored).toEqual(during === 'install' ? [] : [['build']]);
    expect(f.secretLive()).toBe(false);
    expect(closed).toBe(during !== 'install');
    expect(readSetupJournal(options.journal)).toMatchObject({ done: true, exit: 1 });
    expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === active)).toMatchObject({
      state: 'failed',
      detail: 'interrupted',
    });
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!).ok).toBe(false);
    const release = setupClaim();
    release();
  },
);

test('a failed final journal write after no grant returns the final failure exit instead of 2', async () => {
  const f = fixture({
    write: (hash, journal) => {
      if (journal.done) throw new Error('disk full');
      writeSetupJournal(hash, journal);
    },
  });
  f.client.spends = false;
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(1);
  expect(JSON.parse(f.stdout[0]!).ok).toBe(false);
  expect(f.stderr.join('\n')).toContain('Could not finish the setup journal');
});

test('an interrupt during route recording rolls back the unrecorded route and journals interrupted', async () => {
  const controller = new AbortController();
  const commands: string[][] = [];
  const f = fixture({
    signal: controller.signal,
    prepareRoute: async () => ({
      record: { port: 7449, created: true },
      create: ['serve', '--bg', '--https=7449', 'http://127.0.0.1:7787'],
    }),
    createRoute: async (command) => {
      commands.push(command);
    },
    recordRoute: async () => {
      controller.abort();
      throw new Error('plutil stopped');
    },
  });
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(1);
  expect(commands.at(-1)).toEqual(['serve', '--https=7449', 'off']);
  expect(readSetupJournal(options.journal)).toMatchObject({ done: true, exit: 1 });
  expect(readSetupJournal(options.journal)?.steps.find((s) => s.id === 'route')).toMatchObject({
    state: 'failed',
    detail: 'interrupted',
  });
  expect(f.stored).toEqual([]);
  const release = setupClaim();
  release();
});

test('default output is one line per step with a ready headline and one undo line; --verbose keeps the full detail', async () => {
  const quiet = fixture();
  expect(await runSetup([...args, '--yes'], '1.16.0', quiet.deps)).toBe(0);
  const text = quiet.stdout.join('\n');
  expect(text).not.toContain('[running]');
  expect(text).not.toContain('Summary:');
  expect(text).toContain('[ok] approved Client machine for builds');
  expect(text).toContain('[ok] worker is ready to build for Client machine');
  expect(text).toContain(
    'To undo: stim-server devices revoke build-id; stim-server service uninstall --label dev.stim.server',
  );

  const loud = fixture();
  expect(await runSetup([...args, '--yes', '--verbose'], '1.16.0', loud.deps)).toBe(0);
  const detail = loud.stdout.join('\n');
  expect(detail).toContain('[running] stim-server');
  expect(detail).toContain('Undo: stim-server devices revoke build-id');
});

test('a skipped permission names its feature and its fix in the closing summary', async () => {
  const f = fixture({
    tty: true,
    health: health({ screenRecording: false, accessibility: true }),
    permissionWait: async () => true,
  });
  expect(await runSetup([...args, '--device-host', '--yes'], '1.16.0', f.deps)).toBe(3);
  const text = f.stdout.join('\n');
  expect(text).toContain('Screen recording permission skipped: viewing hosted simulators will not work');
  expect(text).toContain(
    'Fix (Screen & System Audio Recording): System Settings > Privacy & Security > Screen & System Audio Recording',
  );
  expect(text).toContain('set up, with gaps');
});

test('a color terminal shows a refusal once, on stdout, and clears its running line before the question', async () => {
  const raw: string[] = [];
  const f = fixture({
    tty: true,
    display: { tty: true, color: true, raw: (t) => void raw.push(t) },
    confirm: async () => {
      expect(raw.at(-1)).toBe('\r\u001b[2K');
      return false;
    },
  });
  expect(await runSetup(args.slice(), '1.16.0', f.deps)).toBe(1);
  expect(f.stderr.join('\n')).not.toContain('approval refused');
  expect(f.stdout.join('\n')).toContain('build refused');
});

test('a registry hint completes only this ticket grant before the next approval repair', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const defaults = defaultSetupDeps();
  let changed = () => {};
  let closed = false;
  let entered = () => {};
  const sleeping = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    now: () => Date.now(),
    sleep: (ms, signal) => {
      entered();
      return defaults.sleep(ms, signal);
    },
    watchRecords: (notify) => {
      changed = notify;
      return () => {
        closed = true;
      };
    },
  });
  f.client.spends = false;
  let finished = false;
  const pending = runSetup([...args, '--yes'], '1.16.0', f.deps).then((code) => {
    finished = true;
    return code;
  });
  try {
    await sleeping;
    f.records.push(record('build', { setupJournal: 'another-ticket' }));
    changed();
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(false);
    f.records.push(record('build'));
    changed();
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    expect(closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(0);
    vi.useRealTimers();
  }
});
