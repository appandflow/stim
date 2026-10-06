import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { readSetupJournal, type SetupJournal } from '@stim-cli/core/state';
import type { PairedDevice } from '../src/registry.ts';
import { writeSetupJournal, pruneSetupJournals } from '../src/setup-journal.ts';
import {
  confirmSetup,
  parseSetupArgs,
  runSetup,
  selectGrants,
  setupClaim,
  setupExitCode,
  setupVersionDecision,
  type SetupDeps,
} from '../src/setup.ts';
import type { InstalledService } from '../src/service-plist.ts';

const now = Date.parse('2026-10-06T12:00:00Z');
const ticket = 't'.repeat(43);
const args = ['--client', 'nClient', '--ticket', ticket, '--expires', '2026-10-06T12:30:00Z', '--build'];
const options = parseSetupArgs(args, now);
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-setup-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function record(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: 'build-id',
    name: 'Client Mac',
    tokenHash: 'unused',
    pairedAt: new Date(now).toISOString(),
    lastSeenAt: null,
    identity: { kind: 'tailnet', nodeId: 'nClient', nodeName: 'client', user: 'user' },
    capabilities: [],
    requestedCapability: 'build',
    pendingUntil: new Date(now + 15 * 60_000).toISOString(),
    setupTicketHash: options.ticketHash,
    ...overrides,
  };
}

function fixture(overrides: Partial<SetupDeps> = {}) {
  let time = now;
  let installClaim = false;
  let version = '1.16.0';
  const records = [record()];
  const grants: { id: string; capabilities: string[] }[] = [];
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
    health: async () => ({ version, stim: '1.16.0', stimHome: home, stimBuild: 'digest' }),
    build: () => ({ version, stimBuild: 'digest' }),
    install: async (_versions, source) => {
      expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'server')?.state).toBe('running');
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
    records: () => {
      expect(installClaim).toBe(false);
      return records;
    },
    grant: (id, capabilities) => {
      const found = records.find((r) => r.id === id);
      if (!found) return 'unknown';
      grants.push({ id, capabilities });
      found.capabilities = capabilities;
      delete found.pendingUntil;
      return 'granted';
    },
    panes: async () => ({ screen: 'Screen & System Audio Recording', control: 'Device Control and Data Access' }),
    permissions: async () => ({ screenRecording: true, accessibility: true }),
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
  return { deps, records, grants, stdout, stderr, actions, snapshots };
}

const match = { ...options, now };
test.each([
  ['another node', { identity: { kind: 'tailnet', nodeId: 'other', nodeName: '', user: '' } }],
  ['loopback', { identity: { kind: 'local' } }],
  ['missing hash', { setupTicketHash: undefined }],
  ['wrong hash', { setupTicketHash: 'wrong' }],
  ['lapsed request', { pendingUntil: new Date(now).toISOString() }],
  ['phone record', { requestedCapability: undefined, capabilities: ['read', 'control'], pendingUntil: undefined }],
  ['wrong capability', { requestedCapability: 'device-host' }],
  ['unapproved non-pending record', { pendingUntil: undefined, capabilities: [] }],
] satisfies [string, Partial<PairedDevice>][])('selector cannot approve %s', (_name, fields) => {
  expect(selectGrants([record(fields)], match)).toEqual([]);
});

test('selector refuses ambiguous requests and keeps an approved ticket from granting a second record', () => {
  const first = record(),
    second = record({ id: 'second' });
  expect(() => selectGrants([first, second], match)).toThrow('More than one');
  const approved = record({ pendingUntil: undefined, capabilities: ['build'] });
  expect(selectGrants([approved, second], match).map((g) => [g.record.id, g.approved])).toEqual([['build-id', true]]);
});

test.each([
  ['no capability', args.slice(0, -1)],
  ['bad ticket', args.map((a) => (a === ticket ? 'short' : a))],
  ['expired', args.map((a) => (a === options.expiresAt ? '2026-10-06T11:00:00Z' : a))],
  ['too far ahead', args.map((a) => (a === options.expiresAt ? '2026-10-06T14:00:01Z' : a))],
  ['not ISO', args.map((a) => (a === options.expiresAt ? 'October 6, 2026' : a))],
  ['invalid date', args.map((a) => (a === options.expiresAt ? '2026-02-30T12:30:00Z' : a))],
  ['bad port', [...args, '--port', '0']],
  ['bad label', [...args, '--label', '../label']],
  ['bad environment', [...args, '--env', 'STIM_HOME=/other']],
  ['bad path', [...args, '--path-prepend', 'relative']],
  ['SSH', [...args, '--ssh']],
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

test('preflight refusal has no claim, journal or install effects', async () => {
  const f = fixture({
    preflight: async () => {
      throw new Error('That Mac is not on this tailnet');
    },
  });
  expect(await runSetup(args, '1.16.0', f.deps)).toBe(1);
  expect(readdirSync(home)).toEqual([]);
  expect(f.actions).toEqual([]);
});

test('build and device-host use distinct grants and a rerun never grants either twice', async () => {
  const f = fixture();
  f.records.push(record({ id: 'host-id', requestedCapability: 'device-host' }));
  const both = [...args, '--device-host', '--yes'];
  expect(await runSetup(both, '1.16.0', f.deps)).toBe(0);
  expect(f.grants).toEqual([
    { id: 'build-id', capabilities: ['build'] },
    { id: 'host-id', capabilities: ['device-host'] },
  ]);
  expect(await runSetup([...args, '--device-host'], '1.16.0', f.deps)).toBe(0);
  expect(f.grants).toHaveLength(2);
  expect(f.stdout.some((line) => line.includes('Already approved'))).toBe(true);
});

test.each([false, true])(
  'no --yes with tty=%s cannot turn an unanswered or N confirmation into approval',
  async (tty) => {
    const f = fixture({ tty });
    expect(await runSetup(args, '1.16.0', f.deps)).toBe(1);
    expect(f.grants).toEqual([]);
    expect(f.stderr.join('\n')).toContain(tty ? 'build approval refused' : 'rerun with --yes or in a terminal');
    expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'approve.build')?.state).toBe(
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
    expect(readSetupJournal(options.ticketHash)).toBeNull();
  } finally {
    release();
  }
});

test.each([
  [null, false, 'install'],
  ['1.15.0', true, 'update'],
  ['1.15.0', false, 'too-old'],
  ['1.16.0', true, 'reuse'],
  ['1.17.0', true, 'reuse'],
  ['2.0.0', false, 'reuse'],
  ['1.16.0-rc.1', false, 'reuse'],
  ['1.16.0-rc.1', true, 'update'],
])('version decision for %s managed=%s preserves upgrades and the reuse floor', (current, managed, expected) => {
  expect(setupVersionDecision(current, '1.16.0', managed)).toBe(expected);
});

test.each([
  ['1.16.0-rc.1', '1.16.0-rc.1', 'reuse'],
  ['1.16.0-rc.1', '1.16.0-rc.2', 'update'],
  ['1.16.0-rc.2', '1.16.0-rc.1', 'reuse'],
])('managed RC %s targeting %s retains full version ordering', (current, desired, expected) => {
  expect(setupVersionDecision(current, desired, true)).toBe(expected);
});

test('Desktop reuse installs no release or LaunchAgent and refuses an old app before waiting', async () => {
  const f = fixture({ installed: async () => null });
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(0);
  expect(f.actions).toEqual(['host']);
  const old = fixture({
    installed: async () => null,
    health: async () => ({ version: '1.15.0', stim: '1.15.0', stimHome: home }),
  });
  expect(await runSetup([...args, '--yes'], '1.16.0', old.deps)).toBe(1);
  expect(old.grants).toEqual([]);
  expect(old.actions).toEqual([]);
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'server')?.fix).toContain(
    'npm install --global @stim-cli/server@1.16.0',
  );
});

test('Funnel refuses before approval and records the off command', async () => {
  const f = fixture({ route: async () => ({ state: 'funneled', port: 7444, ports: [7443] }) });
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(1);
  expect(f.actions).toEqual(['host', 'service']);
  expect(f.grants).toEqual([]);
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'route')).toMatchObject({
    state: 'failed',
    fix: 'tailscale funnel --https=7443 off',
  });
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
    granted: [{ capability: 'build', id: 'build-id', client: { nodeId: 'nClient', name: 'Client Mac' } }],
    permissions: { screenRecording: 'not-needed', deviceControl: 'not-needed' },
    warnings: [],
  });
  expect(readSetupJournal(options.ticketHash)).toMatchObject({ done: true, exit: 0 });
});

test('no request before expiry finishes with 2 and never asks for permissions or tools', async () => {
  const f = fixture({
    toolchain: async () => {
      throw new Error('Must not inspect tools');
    },
  });
  f.records.length = 0;
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(2);
  expect(f.grants).toEqual([]);
});

test('a timed-out permission opens its settings pane, reports the lost feature, and keeps a partial-success journal', async () => {
  const f = fixture({ permissions: async () => ({ screenRecording: false, accessibility: true }) });
  f.records.push(record({ id: 'host-id', requestedCapability: 'device-host' }));
  expect(await runSetup([...args, '--device-host', '--yes'], '1.16.0', f.deps)).toBe(3);
  expect(f.actions.filter((a) => a === 'Privacy_ScreenCapture')).toHaveLength(1);
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'permissions.screenRecording')).toMatchObject(
    { state: 'pending', detail: 'pending: viewing hosted simulators will not work.' },
  );
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
      client: { nodeId: 'nClient' },
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
    health: async () => (ready ? { version: '1.16.0', stim: '1.16.0', stimHome: home, stimBuild: 'digest' } : null),
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

test('a newer managed server stays installed and a different Stim build produces partial success', async () => {
  const f = fixture({
    health: async () => ({ version: '1.17.0', stim: '1.17.0', stimHome: home, stimBuild: 'new-digest' }),
  });
  expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(3);
  expect(f.actions).toEqual(['host', 'service']);
  expect(JSON.parse(f.stdout[0]!).server).toEqual({ version: '1.17.0', stimBuild: 'new-digest' });
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'tools.Stim build')?.state).toBe('pending');
});

test('an older managed server upgrades before installation instead of waiting with an unsupported journal route', async () => {
  let upgraded = false;
  const f = fixture({
    health: async () => ({
      version: upgraded ? '1.16.0' : '1.15.0',
      stim: '1.16.0',
      stimHome: home,
      stimBuild: 'digest',
    }),
    update: async (_label, _installed, source) => {
      expect(source).toEqual({ release: '1.16.0' });
      upgraded = true;
      return [];
    },
  });
  expect(await runSetup([...args, '--yes'], '1.16.0', f.deps)).toBe(0);
  expect(upgraded).toBe(true);
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'server')?.title).toBe('stim-server 1.16.0');
});

test('approval cannot outlive the ticket while a terminal question is open', async () => {
  const f = fixture({ tty: true });
  f.deps.confirm = async (_question, timeout) => {
    await f.deps.sleep(timeout);
    return true;
  };
  expect(await runSetup(args, '1.16.0', f.deps)).toBe(2);
  expect(f.grants).toEqual([]);
});

test('terminal permission skip names the unavailable feature without changing TCC or failing the grant', async () => {
  const f = fixture({
    tty: true,
    permissions: async () => ({ screenRecording: true, accessibility: false }),
    permissionWait: async () => true,
  });
  f.records.push(record({ id: 'host-id', requestedCapability: 'device-host' }));
  expect(await runSetup([...args, '--device-host', '--yes', '--json'], '1.16.0', f.deps)).toBe(3);
  expect(f.grants).toHaveLength(2);
  expect(JSON.parse(f.stdout[0]!).permissions).toEqual({ screenRecording: 'granted', deviceControl: 'skipped' });
  expect(
    readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'permissions.deviceControl')?.detail,
  ).toContain('controlling hosted simulators will not work');
});

test('hosting alone does not require build-only tools or prompt for an existing app permission grant', async () => {
  const f = fixture({
    installed: async () => null,
    health: async () => ({
      version: '1.16.0',
      stim: '1.16.0',
      stimHome: home,
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
  f.records.splice(0, 1, record({ id: 'host-id', requestedCapability: 'device-host' }));
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

test('client whitespace is trimmed before selecting node-bound grants', () => {
  const trimmed = parseSetupArgs(
    args.map((arg) => (arg === 'nClient' ? ' nClient ' : arg)),
    now,
  );
  expect(trimmed.nodeId).toBe('nClient');
  expect(selectGrants([record()], { ...trimmed, now }).map((g) => g.record.id)).toEqual(['build-id']);
});

test.each(['pending', 'wrong node', 'wrong ticket', 'missing capability'])(
  'noninteractive setup with %s approval refuses before any installation or claim',
  async (kind) => {
    const f = fixture();
    f.records[0] = record({
      pendingUntil: kind === 'pending' ? options.expiresAt : undefined,
      capabilities: ['build'],
      ...(kind === 'wrong node' ? { identity: { kind: 'tailnet', nodeId: 'other', nodeName: '', user: '' } } : {}),
      ...(kind === 'wrong ticket' ? { setupTicketHash: 'other' } : {}),
    });
    expect(await runSetup(kind === 'missing capability' ? [...args, '--device-host'] : args, '1.16.0', f.deps)).toBe(1);
    expect(f.actions).toEqual([]);
    expect(f.grants).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  },
);

test('the later noninteractive guard refuses an approval revoked during installation', async () => {
  const f = fixture();
  f.records[0] = record({ pendingUntil: undefined, capabilities: ['build'] });
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
  expect(f.grants).toEqual([]);
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'approve')?.state).toBe('failed');
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
    expect(f.grants).toEqual([]);
    expect(readSetupJournal(options.ticketHash)).toMatchObject({ done: true, exit: 1 });
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
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'route')).toMatchObject({
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
  expect(f.grants).toEqual([]);
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'route')).toMatchObject({
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
    expect(f.grants).toEqual([]);
    expect(readSetupJournal(options.ticketHash)).toMatchObject({ done: true, exit: 1 });
    expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'approve')).toMatchObject({
      state: 'failed',
      detail: 'interrupted',
    });
    const release = setupClaim();
    release();
    stream.destroy();
  },
);

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
    const f = fixture({ signal: controller.signal });
    const active = during === 'install' ? 'server' : during === 'tools' ? 'tools' : 'approve';
    if (during === 'install') {
      f.deps.installed = async () => null;
      f.deps.health = async () => null;
      f.deps.install = interrupt;
    } else if (during === 'tools') f.deps.toolchain = interrupt;
    else {
      f.records.length = 0;
      f.deps.sleep = interrupt;
    }
    expect(await runSetup([...args, '--yes', '--json'], '1.16.0', f.deps)).toBe(1);
    expect(readSetupJournal(options.ticketHash)).toMatchObject({ done: true, exit: 1 });
    expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === active)).toMatchObject({
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
  f.records.length = 0;
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
  expect(readSetupJournal(options.ticketHash)).toMatchObject({ done: true, exit: 1 });
  expect(readSetupJournal(options.ticketHash)?.steps.find((s) => s.id === 'route')).toMatchObject({
    state: 'failed',
    detail: 'interrupted',
  });
  expect(f.grants).toEqual([]);
  const release = setupClaim();
  release();
});
