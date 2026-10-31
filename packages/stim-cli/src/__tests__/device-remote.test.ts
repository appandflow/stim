import assert from 'node:assert';
import { setExecutor, resetExecutor, type Executor } from '../exec.ts';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspaceStorage, workspaceStateFile } from '../workspace/paths.ts';
import { remoteProfilePath } from '../engine/agent-device.ts';
import {
  endRecordedSession,
  ensureRemoteBootOwned,
  ensureMetroReachable,
  remoteAndroidDeps,
  remoteIosDeps,
  resolveRemoteContext,
  teardownRemote,
} from '../engine/device-remote.ts';
import { PUBLIC_METRO_ENV } from '../engine/metro-reach.ts';
import { withDirLockTransaction } from '@stim-cli/core';
import { easSessionLedgerLock } from '@stim-cli/core/state';
import { readEasSessionLedger, recordEasSessionClaim } from '../engine/eas-session-ledger.ts';
import { saveConfig } from '../workspace/config.ts';

const EAS_CLI_VERSION = () => 'eas-cli/24.8.0 darwin-arm64 node-v22.22.2';

const LOOPBACK = { baseUrl: 'http://127.0.0.1:4310', token: 'tok_proxy' };

const CREATED = JSON.stringify({
  id: 'drs_42',
  name: 'stim-wt',
  type: 'agent-device',
  deviceRunSessionUrl: 'https://expo.dev/x',
  remoteConfig: {
    __typename: 'AgentDeviceRunSessionRemoteConfig',
    agentDeviceRemoteSessionUrl: 'https://sim-42.eas.dev/daemon',
    agentDeviceRemoteSessionToken: 'tok_secret',
  },
});

interface Call {
  file: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  omitEnv?: readonly string[];
  timeoutMs?: number;
}

function mockExec({
  fail = null,
  outputs = {},
  errors = {},
}: {
  fail?: string | null;
  outputs?: Record<string, string>;
  errors?: Record<string, Error & { stderr?: string }>;
  existingDaemonMode?: boolean;
} = {}) {
  const calls: Call[] = [];
  const exec: Executor & { calls: Call[] } = {
    calls,
    async runFileAsync(file: string, args: string[] = [], opts: object = {}) {
      const o = opts as { env?: Record<string, string>; cwd?: string; omitEnv?: readonly string[]; timeoutMs?: number };
      calls.push({ file, args, env: o.env, cwd: o.cwd, omitEnv: o.omitEnv, timeoutMs: o.timeoutMs });
      const key = [file, ...args].join(' ');
      if (fail && key.includes(fail)) throw new Error(`Command failed: ${key}`);
      for (const [match, error] of Object.entries(errors)) {
        if (key.includes(match)) throw error;
      }
      for (const [match, value] of Object.entries(outputs)) {
        if (match === args[0] || (match !== 'sim' && key.includes(match))) return value;
      }
      if (args[0] === 'simulator:stop') {
        const idIndex = args.indexOf('--id');
        return JSON.stringify({ id: args[idIndex + 1], status: 'STOPPED' });
      }
      return '';
    },
    run() {
      throw new Error('device-remote must use runFile, not the shell');
    },
    runQuiet() {
      throw new Error('device-remote must use runFile, not the shell');
    },
    runFileQuiet() {
      throw new Error('device-remote must use runFile, not runFileQuiet');
    },
    runFile() {
      throw new Error('device-remote must use asynchronous commands');
    },
    runFileQuietAsync() {
      throw new Error('device-remote must use runFile, not runFileQuietAsync');
    },
    spawn() {
      throw new Error('device-remote does not spawn');
    },
    findExecutable: () => null,
  };
  setExecutor(exec);
  return exec;
}

let root: string;
let tmpHome: string;
function ctx(overrides: Partial<Parameters<typeof remoteIosDeps>[0]> = {}) {
  const backend = overrides.backend ?? (overrides.existingDaemon ? 'proxy' : 'eas');
  return {
    root,
    label: 'wt',
    backend,
    easBin: '/bin/eas',
    agentDeviceBin: '/bin/agent-device',
    easLedgerRoot: tmpHome,
    sleep: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-home-'));
  process.env.STIM_HOME = tmpHome;
  root = mkdtempSync(join(tmpdir(), 'stim-remote-'));
});
afterEach(() => {
  resetExecutor();
  rmSync(root, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe('explicit backend selection', () => {
  const env = {
    AGENT_DEVICE_DAEMON_BASE_URL: 'https://proxy.example/agent-device',
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'tok_proxy',
  };

  test('proxy requires both daemon variables with a precise remedy', async () => {
    const missingToken = await resolveRemoteContext({
      root,
      backend: 'proxy',
      easBin: '/bin/eas',
      env: { AGENT_DEVICE_DAEMON_BASE_URL: env.AGENT_DEVICE_DAEMON_BASE_URL },
      lookupAgentDevice: () => '/bin/agent-device',
    });
    expect(missingToken).toEqual({
      failed: 'The proxy backend requires AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
      remedy: 'Export AGENT_DEVICE_DAEMON_AUTH_TOKEN, then run the device command with `--remote proxy` again.',
      code: 'STIM_REMOTE_PROXY_CONFIG',
    });

    const missingUrl = await resolveRemoteContext({
      root,
      backend: 'proxy',
      easBin: '/bin/eas',
      env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: env.AGENT_DEVICE_DAEMON_AUTH_TOKEN },
      lookupAgentDevice: () => '/bin/agent-device',
    });
    expect(missingUrl).toEqual({
      failed: 'The proxy backend requires AGENT_DEVICE_DAEMON_BASE_URL.',
      remedy: 'Export AGENT_DEVICE_DAEMON_BASE_URL, then run the device command with `--remote proxy` again.',
      code: 'STIM_REMOTE_PROXY_CONFIG',
    });
  });

  test('proxy uses only the supplied daemon and never creates an EAS session', async () => {
    const resolved = await resolveRemoteContext({
      root,
      backend: 'proxy',
      easBin: '/bin/eas',
      env,
      lookupAgentDevice: () => '/bin/agent-device',
    });
    expect('ctx' in resolved).toBe(true);
    if (!('ctx' in resolved)) return;
    expect(resolved.ctx.backend).toBe('proxy');
    expect(resolved.ctx.existingDaemon).toEqual({
      baseUrl: env.AGENT_DEVICE_DAEMON_BASE_URL,
      token: env.AGENT_DEVICE_DAEMON_AUTH_TOKEN,
    });

    const exec = mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(resolved.ctx).ensureBooted({});
    expect(exec.calls.some((call) => call.file === '/bin/eas')).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'eas child processes omit proxy credentials and preserve the project environment (POSIX executable stub; skipped on win32)',
    async () => {
      const easBin = join(root, 'fake-eas.cjs');
      const agentDeviceBin = join(root, 'fake-agent-device');
      const reportPath = join(root, 'eas-child-env.json');
      writeFileSync(
        easBin,
        `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('eas-cli/24.8.0 darwin-arm64 node-v22.22.2\\n');
  process.exit(0);
}
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
  hasProxyUrl: Object.hasOwn(process.env, 'AGENT_DEVICE_DAEMON_BASE_URL'),
  hasProxyToken: Object.hasOwn(process.env, 'AGENT_DEVICE_DAEMON_AUTH_TOKEN'),
  expoToken: process.env.EXPO_TOKEN,
  path: process.env.PATH,
  lang: process.env.LANG,
  projectVariable: process.env.STIM_EAS_PROJECT_VARIABLE,
}));
process.stdout.write(${JSON.stringify(CREATED)});
`,
      );
      writeFileSync(agentDeviceBin, '#!/bin/sh\nexit 0\n');
      chmodSync(easBin, 0o755);
      chmodSync(agentDeviceBin, 0o755);

      const keys = [
        'AGENT_DEVICE_DAEMON_BASE_URL',
        'AGENT_DEVICE_DAEMON_AUTH_TOKEN',
        'EXPO_TOKEN',
        'LANG',
        'STIM_EAS_PROJECT_VARIABLE',
      ] as const;
      const previous = new Map(keys.map((key) => [key, process.env[key]]));
      const expectedPath = process.env.PATH;
      try {
        process.env.AGENT_DEVICE_DAEMON_BASE_URL = 'https://proxy.example/agent-device';
        process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = 'proxy-token-fixture';
        process.env.EXPO_TOKEN = 'expo-token-fixture';
        process.env.LANG = 'stim-test-locale';
        process.env.STIM_EAS_PROJECT_VARIABLE = 'project-value';

        const resolved = await resolveRemoteContext({
          root,
          backend: 'eas',
          easBin,
          env: process.env,
          lookupAgentDevice: () => agentDeviceBin,
        });
        expect('ctx' in resolved).toBe(true);
        if (!('ctx' in resolved)) return;
        const booted = await remoteIosDeps(resolved.ctx).ensureBooted({});
        expect(booted.ok).toBe(true);

        expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual({
          hasProxyUrl: false,
          hasProxyToken: false,
          expoToken: 'expo-token-fixture',
          path: expectedPath,
          lang: 'stim-test-locale',
          projectVariable: 'project-value',
        });
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );
});

describe('the expensive step happens after the Metro gate', () => {
  test('ensureOwnedDevice creates no session and runs no command', async () => {
    const exec = mockExec();
    const deps = remoteIosDeps(ctx());
    const device = await deps.ensureOwnedDevice();
    expect(exec.calls).toEqual([]);
    expect(device.remote).toBe(true);
    expect(deps.createdSessionId()).toBeNull();
  });
});

describe('the remote session workspace lock', () => {
  test('a holder past the longest EAS session start is refused by name, and the waiter never boots', async () => {
    const ledgerRoot = join(root, 'machine-eas');
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = ensureRemoteBootOwned({
      root,
      platform: 'ios',
      sessionName: 'stim-first',
      startedAt: '2026-09-25T00:00:00.000Z',
      boot: async () => {
        firstEntered();
        await held;
        return { ok: true };
      },
      createdSessionId: () => null,
      abandonCreatedSession: () => ({ ok: true, sessionId: null }),
      writeState: () => {},
      ledgerRoot,
    });
    try {
      await entered;
      const otherRoot = join(root, 'other');
      mkdirSync(otherRoot);
      let secondBooted = false;
      let clockReads = 0;
      const second = await ensureRemoteBootOwned({
        root: otherRoot,
        platform: 'ios',
        sessionName: 'stim-second',
        startedAt: '2026-09-25T00:00:00.000Z',
        boot: async () => {
          secondBooted = true;
          return { ok: true };
        },
        createdSessionId: () => null,
        abandonCreatedSession: () => ({ ok: true, sessionId: null }),
        writeState: () => {},
        ledgerRoot,
        now: () => Date.now() + (clockReads++ === 0 ? 0 : 60 * 60_000),
      });
      expect(secondBooted).toBe(false);
      expect(second).toMatchObject({
        failed: true,
        code: 'STIM_LOCK_TIMEOUT',
        remedy: `If pid ${process.pid} is stuck, stop it, then run the remote command again.`,
      });
      expect((second as { reason: string }).reason).toContain(
        `EAS remote start (pid ${process.pid}, in ${root}, running for 60m`,
      );
    } finally {
      releaseFirst();
      await first;
    }
  });
});

describe('session creation', () => {
  test('awaits registration and publishes the fixed ownership claim before workspace state', async () => {
    const ledgerRoot = join(tmpHome, 'machine-eas');
    let claimVisibleDuringStateWrite = false;
    let statePatch: Record<string, unknown> | null = null;
    let registered = false;

    const result = await ensureRemoteBootOwned({
      root,
      platform: 'ios',
      sessionName: 'stim-wt',
      startedAt: '2026-08-28T00:00:00.000Z',
      deviceType: 'iPhone 17 Pro',
      register: async () => {
        await Promise.resolve();
        registered = true;
      },
      boot: async () => {
        expect(registered).toBe(true);
        return { ok: true, udid: 'drs_claimed' };
      },
      createdSessionId: () => 'drs_claimed',
      abandonCreatedSession: () => ({ ok: true, sessionId: 'drs_claimed' }),
      webPreviewUrl: () => 'https://preview.example/drs_claimed',
      writeState: (_root, patch) => {
        claimVisibleDuringStateWrite = readEasSessionLedger(ledgerRoot).claims.has('drs_claimed');
        statePatch = patch;
      },
      withProjectLock: async (_project, fn) => fn(),
      withLock: async (_project, fn) => fn(),
      ledgerRoot,
    });

    expect('failed' in result && result.failed).toBe(false);
    expect(claimVisibleDuringStateWrite).toBe(true);
    expect(statePatch).toEqual({
      remoteDevice: {
        platform: 'ios',
        sessionId: 'drs_claimed',
        startedAt: '2026-08-28T00:00:00.000Z',
        webPreviewUrl: 'https://preview.example/drs_claimed',
        deviceType: 'iPhone 17 Pro',
      },
    });
  });

  test('a claim write failure stops the new session before state publication', async () => {
    const blockedRoot = join(tmpHome, 'blocked-ledger');
    writeFileSync(blockedRoot, 'not a directory');
    let abandoned = false;
    let stateWritten = false;

    const result = await ensureRemoteBootOwned({
      root,
      platform: 'ios',
      sessionName: 'stim-wt',
      startedAt: '2026-08-28T00:00:00.000Z',
      boot: async () => ({ ok: true, udid: 'drs_unclaimed' }),
      createdSessionId: () => 'drs_unclaimed',
      abandonCreatedSession: () => {
        abandoned = true;
        return { ok: true, sessionId: 'drs_unclaimed' };
      },
      writeState: () => {
        stateWritten = true;
      },
      withProjectLock: async (_project, fn) => fn(),
      withLock: async (_project, fn) => fn(),
      ledgerRoot: blockedRoot,
    });

    expect('failed' in result && result.failed).toBe(true);
    expect(abandoned).toBe(true);
    expect(stateWritten).toBe(false);
  });

  test.each([
    ['false result', () => false],
    [
      'throw',
      () => {
        throw new Error('claim store unavailable');
      },
    ],
  ])('a state publication failure contains a claim-removal %s after verified stop', async (_label, removeClaim) => {
    const ledgerRoot = join(tmpHome, 'machine-eas');

    const result = await ensureRemoteBootOwned({
      root,
      platform: 'ios',
      sessionName: 'stim-wt',
      startedAt: '2026-08-28T00:00:00.000Z',
      boot: async () => ({ ok: true, udid: 'drs_claimed' }),
      createdSessionId: () => 'drs_claimed',
      abandonCreatedSession: () => ({ ok: true, sessionId: 'drs_claimed' }),
      writeState: () => {
        throw new Error('state store unavailable');
      },
      removeEasSessionClaim: removeClaim,
      withProjectLock: async (_project, fn) => fn(),
      withLock: async (_project, fn) => fn(),
      ledgerRoot,
    });

    expect('failed' in result && result.failed).toBe(true);
    expect('code' in result && result.code).toBe('STIM_REMOTE_SESSION_CLEANUP');
    expect('reason' in result && result.reason).toMatch(/session.*stopped.*ownership claim.*could not be removed/i);
    expect('remedy' in result && result.remedy).toContain(ledgerRoot);
    expect(readEasSessionLedger(ledgerRoot).claims.has('drs_claimed')).toBe(true);
  });

  describe('session duration cap', () => {
    const create = async () => {
      const resolved = await resolveRemoteContext({
        root,
        backend: 'eas',
        easBin: '/bin/eas',
        env: {},
        lookupAgentDevice: () => '/bin/agent-device',
        readEasCliVersion: EAS_CLI_VERSION,
      });
      if (!('ctx' in resolved)) return resolved;
      const exec = mockExec({ outputs: { sim: CREATED } });
      await remoteIosDeps({ ...resolved.ctx, easLedgerRoot: tmpHome, sleep: async () => {} }).ensureBooted({});
      const args = exec.calls[0]?.args ?? [];
      return args[args.indexOf('--max-duration-minutes') + 1];
    };

    test('an invalid machine value refuses instead of creating an uncapped session', async () => {
      saveConfig({ projects: {}, repos: {}, remote: { easMaxDurationMinutes: 0 } });
      expect(await create()).toMatchObject({
        code: 'STIM_BAD_ARG',
        failed: expect.stringContaining('remote.easMaxDurationMinutes'),
      });
    });
  });

  test('an Expo app without an EAS project gets the EAS link remedy, not the owned-simulator one', async () => {
    const stderr = [
      '★ eas-cli@25.3.0 is now available.',
      'EAS project not configured. This command cannot configure it in non-interactive mode. Run one of the following, then re-run this command:',
      '  eas init --id <project-id> --non-interactive',
    ].join('\n');
    mockExec({ errors: { sim: Object.assign(new Error('simulator command failed.'), { stderr }) } });
    const booted = await remoteIosDeps(ctx()).ensureBooted({});
    expect(booted).toEqual({
      failed: true,
      code: 'STIM_REMOTE_EAS_UNAVAILABLE',
      reason: 'The Expo app is not linked to an EAS project, so no EAS Simulator session was created.',
      remedy:
        'Link it with `eas init --id <project-id> --non-interactive` (existing project) or `eas init --account <account-name> --non-interactive` (new project), then run `stim ios --remote eas` again.',
    });
  });

  test('an eas sim that outlives its deadline names the session it may have left running', async () => {
    const timedOut = Object.assign(new Error('Command timed out after 600000ms: /bin/eas sim'), { code: 'ETIMEDOUT' });
    mockExec({ errors: { sim: timedOut } });
    const booted = await remoteIosDeps(ctx()).ensureBooted({});
    expect(booted.failed).toBe(true);
    expect(booted.reason).toContain('stim-wt');
    expect(booted.remedy).toContain('eas simulator:list --name stim-wt');
  });
});

describe('fixed ownership claim teardown', () => {
  test('recording a session claim waits for a held ledger lock without blocking the event loop', async () => {
    const ledgerRoot = join(tmpHome, 'machine-eas');
    let release = () => {};
    const holding = withDirLockTransaction(
      easSessionLedgerLock(ledgerRoot),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      { ensureParent: () => mkdirSync(ledgerRoot, { recursive: true }) },
    );
    let ticks = 0;
    const timer = setInterval(() => {
      if (++ticks === 10) release();
    }, 20);
    try {
      await recordEasSessionClaim(
        {
          sessionId: 'drs_waited',
          name: 'stim-wt',
          platform: 'ios',
          workspaceRoot: root,
          workspaceHome: tmpHome,
          stateFile: workspaceStateFile(root),
        },
        ledgerRoot,
      );
    } finally {
      clearInterval(timer);
      release();
      await holding;
    }
    expect(ticks).toBeGreaterThanOrEqual(10);
    expect([...readEasSessionLedger(ledgerRoot).claims.keys()]).toEqual(['drs_waited']);
  });

  test('verified teardown removes the claim', async () => {
    const ledgerRoot = join(tmpHome, 'machine-eas');
    await recordEasSessionClaim(
      {
        sessionId: 'drs_42',
        name: 'stim-wt',
        platform: 'ios',
        workspaceRoot: root,
        workspaceHome: tmpHome,
        stateFile: workspaceStateFile(root),
      },
      ledgerRoot,
    );
    mockExec({
      outputs: {
        'simulator:get': JSON.stringify({ id: 'drs_42', name: 'stim-wt', status: 'IN_PROGRESS' }),
      },
    });

    const lock = easSessionLedgerLock(ledgerRoot);
    mkdirSync(lock);
    const release = setTimeout(() => rmSync(lock, { recursive: true }), 50);
    try {
      expect((await teardownRemote(ctx({ easLedgerRoot: ledgerRoot }), { sessionId: 'drs_42' })).status).toBe(
        'torn-down',
      );
      expect(readEasSessionLedger(ledgerRoot).claims.has('drs_42')).toBe(false);
    } finally {
      clearTimeout(release);
      rmSync(lock, { recursive: true, force: true });
    }
  });

  test('failed teardown keeps the claim', async () => {
    const ledgerRoot = join(tmpHome, 'machine-eas');
    await recordEasSessionClaim(
      {
        sessionId: 'drs_42',
        name: 'stim-wt',
        platform: 'ios',
        workspaceRoot: root,
        workspaceHome: tmpHome,
        stateFile: workspaceStateFile(root),
      },
      ledgerRoot,
    );
    mockExec({ fail: 'simulator:get' });

    expect((await teardownRemote(ctx({ easLedgerRoot: ledgerRoot }), { sessionId: 'drs_42' })).status).toBe('failed');
    expect(readEasSessionLedger(ledgerRoot).claims.has('drs_42')).toBe(true);
  });

  test('verified teardown contains a throwing claim removal and reports reconciliation', async () => {
    const ledgerRoot = join(tmpHome, 'machine-eas');
    await recordEasSessionClaim(
      {
        sessionId: 'drs_42',
        name: 'stim-wt',
        platform: 'ios',
        workspaceRoot: root,
        workspaceHome: tmpHome,
        stateFile: workspaceStateFile(root),
      },
      ledgerRoot,
    );
    mockExec({
      outputs: {
        'simulator:get': JSON.stringify({ id: 'drs_42', name: 'stim-wt', status: 'IN_PROGRESS' }),
      },
    });

    const result = await teardownRemote(
      ctx({
        easLedgerRoot: ledgerRoot,
        removeEasSessionClaim: () => {
          throw new Error('claim store unavailable');
        },
      }),
      { sessionId: 'drs_42' },
    );

    expect(result.status).toBe('torn-down');
    expect(result.reason).toMatch(/ownership claim.*could not be removed/i);
  });

  test('verified teardown reports a false claim removal for reconciliation', async () => {
    const ledgerRoot = join(tmpHome, 'machine-eas');
    await recordEasSessionClaim(
      {
        sessionId: 'drs_42',
        name: 'stim-wt',
        platform: 'ios',
        workspaceRoot: root,
        workspaceHome: tmpHome,
        stateFile: workspaceStateFile(root),
      },
      ledgerRoot,
    );
    mockExec({
      outputs: {
        'simulator:get': JSON.stringify({ id: 'drs_42', name: 'stim-wt', status: 'IN_PROGRESS' }),
      },
    });

    const result = await teardownRemote(ctx({ easLedgerRoot: ledgerRoot, removeEasSessionClaim: () => false }), {
      sessionId: 'drs_42',
    });

    expect(result.status).toBe('torn-down');
    expect(result.reason).toMatch(/ownership claim.*could not be removed/i);
  });
});

describe('the token never reaches disk', () => {
  test('the profile written next to it contains no credential', async () => {
    mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(ctx()).ensureBooted({});
    const profilePath = remoteProfilePath(root);
    expect(existsSync(profilePath)).toBe(true);
    const written = readFileSync(profilePath, 'utf-8');
    expect(written).not.toContain('tok_secret');
    expect(JSON.parse(written).daemonBaseUrl).toBe('https://sim-42.eas.dev/daemon');
  });

  test('it travels as an env var on every agent-device call instead', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' }));
    await deps.ensureBooted({});
    await deps.installIosApp({ udid: 'drs_42', appPath: '/tmp/My App.app' });
    await deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082 });
    const agentCalls = exec.calls.filter((c) => c.file === '/bin/agent-device');
    expect(agentCalls.length).toBe(4);
    for (const call of agentCalls) {
      expect(call.env?.AGENT_DEVICE_DAEMON_AUTH_TOKEN).toBe('tok_proxy');
    }
  });

  test('the profile lives in global workspace storage, never in the project itself', async () => {
    mockExec({ outputs: { sim: CREATED } });
    await remoteIosDeps(ctx()).ensureBooted({});
    expect(existsSync(join(root, 'agent-device.remote.json'))).toBe(false);
    expect(existsSync(join(root, '.env.eas-simulator'))).toBe(false);
  });
});

describe('install and launch match their local counterparts', () => {
  test('install before a connection is a reason, not a crash', async () => {
    mockExec();
    const result = await remoteIosDeps(ctx()).installIosApp({ udid: 'x', appPath: '/tmp/a.app' });
    expect(result.failed).toBe(true);
    expect(result.reason).toContain('No remote session');
  });

  test('a failure on a proxy daemon names no billable session', async () => {
    mockExec({ fail: 'install' });
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK }));
    await deps.ensureBooted({});
    expect((await deps.installIosApp({ udid: 'x', appPath: '/tmp/a.app' })).failed).toBe(true);
    expect(deps.failureRemedy()).not.toContain('billed');
  });
});

describe('teardown', () => {
  test('isolates proxy credentials from both lookup and stop', async () => {
    const exec = mockExec({
      outputs: {
        'simulator:get': JSON.stringify({ id: 'drs_42', name: 'stim-wt', status: 'IN_PROGRESS' }),
        'simulator:stop': JSON.stringify({ id: 'drs_42', status: 'STOPPED' }),
      },
    });
    await teardownRemote(ctx(), { sessionId: 'drs_42' });
    const easCalls = exec.calls.filter((call) => call.file === '/bin/eas');
    expect(easCalls).toHaveLength(2);
    for (const call of easCalls) {
      expect(call.omitEnv).toEqual(['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN']);
      expect(call.timeoutMs).toBe(30_000);
    }
  });
});

describe('Metro reachability', () => {
  test('launching against an unreachable Metro refuses instead of opening the app', async () => {
    mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx());
    await deps.ensureBooted({});
    const result = await deps.launchIosApp({
      udid: 'drs_42',
      bundleId: 'com.example.app',
      metroPort: 8082,
      devClientScheme: 'myapp',
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe('STIM_REMOTE_METRO_UNREACHABLE');
  });
});

async function reach(over: Record<string, unknown> = {}, platform: 'ios' | 'android' = 'ios') {
  const context = {
    root,
    label: 'wt',
    platform,
    easBin: '/bin/eas',
    agentDeviceBin: '/bin/agent-device',
    publicMetroUrl: null as string | null,
  };
  const result = await ensureMetroReachable({
    ctx: context,
    metroPort: 8085,
    isExpo: false,
    env: {},
    gateOrigin: async () => ({ ok: true as const }),
    ...over,
  } as unknown as Parameters<typeof ensureMetroReachable>[0]);
  return { result, context };
}

describe('the Metro refusal comes before anything billable', () => {
  test('an Expo Router project gates the bundle entry declared by package.json', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'expo-router/entry' }));
    let entryPoint: string | null = null;
    const { result } = await reach({
      isExpo: true,
      env: { [PUBLIC_METRO_ENV]: 'https://abc.ngrok.app' },
      gateOrigin: async (options: { entryPoint?: string }) => {
        entryPoint = options.entryPoint ?? null;
        return { ok: true as const };
      },
    });

    expect('ok' in result).toBe(true);
    expect(entryPoint).toBe('node_modules/expo-router/entry');
  });
});

describe('a tunnel Stim starts for itself', () => {
  test('a gate failure refuses with the gate stable code, and sets no origin', async () => {
    const { result, context } = await reach({
      available: ['cloudflared'],
      readTunnelRecord: () => ({
        kind: 'managed',
        provider: 'cloudflared',
        pid: 1,
        url: 'https://t.trycloudflare.com',
        port: 8085,
        startedAt: 'T',
      }),
      isTunnelAlive: () => true,
      gateOrigin: async () => ({
        failed: true as const,
        code: 'STIM_REMOTE_METRO_WRONG',
        reason: 'wrong',
        remedy: 'fix',
      }),
    });
    expect('failed' in result).toBe(true);
    assert('failed' in result);
    expect(result.code).toBe('STIM_REMOTE_METRO_WRONG');
    expect(context.publicMetroUrl).toBeNull();
  });
});

describe('a session Stim created is never abandoned', () => {
  const NO_ENDPOINT = JSON.stringify({ id: 'drs_9', remoteConfig: null });

  test('when the stop also fails, the id and the manual command are reported', async () => {
    mockExec({ outputs: { sim: NO_ENDPOINT, 'simulator:get': NO_ENDPOINT }, fail: 'simulator:stop' });
    const booted = await remoteIosDeps(ctx({ existingDaemon: null })).ensureBooted({});
    expect(booted.reason).toContain('eas simulator:stop --id drs_9');
    expect(booted.reason).toContain('bills until its cap');
  });
});

describe('a re-run does not orphan the session it already has', () => {
  function recordSession(id: string): void {
    ensureWorkspaceStorage(root);
    writeFileSync(workspaceStateFile(root), JSON.stringify({ remoteDevice: { platform: 'ios', sessionId: id } }));
  }

  const LIVE = JSON.stringify({
    id: 'drs_old',
    name: 'stim-wt',
    status: 'IN_PROGRESS',
    remoteConfig: {
      agentDeviceRemoteSessionUrl: 'https://old.eas.dev/daemon',
      agentDeviceRemoteSessionToken: 'tok_old',
    },
  });

  test('a recorded session on the requested model, or a run without --device-type, reuses it', async () => {
    ensureWorkspaceStorage(root);
    writeFileSync(
      workspaceStateFile(root),
      JSON.stringify({ remoteDevice: { platform: 'ios', sessionId: 'drs_old', deviceType: 'iPhone 17 Pro' } }),
    );
    for (const deviceType of ['iPhone 17 Pro', null]) {
      const exec = mockExec({ outputs: { 'simulator:get': LIVE, sim: CREATED } });
      expect((await remoteIosDeps(ctx({ deviceType })).ensureBooted({})).ok).toBe(true);
      expect(exec.calls.some((call) => call.args[0] === 'sim')).toBe(false);
    }
  });

  test('android refuses an iOS session without stopping or replacing it', async () => {
    recordSession('drs_ios');
    const exec = mockExec({ outputs: { sim: CREATED } });

    const booted = await remoteAndroidDeps(ctx()).ensureDeviceBooted({});

    expect(booted.failed).toBe(true);
    expect(booted.code).toBe('STIM_REMOTE_PLATFORM_MISMATCH');
    expect(booted.reason).toContain('drs_ios');
    expect(exec.calls.some((call) => call.args[0] === 'sim')).toBe(false);
    expect(exec.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
  });

  test('a verified terminal recorded session is replaced without another stop', async () => {
    recordSession('drs_dead');
    const exec = mockExec({
      outputs: {
        'simulator:get': JSON.stringify({ id: 'drs_dead', name: 'stim-wt', status: 'ERRORED' }),
        sim: CREATED,
      },
    });
    await remoteIosDeps(ctx()).ensureBooted({});
    expect(exec.calls.some((c) => c.args[0] === 'simulator:stop')).toBe(false);
    expect(exec.calls.some((c) => c.args[0] === 'sim')).toBe(true);
  });

  test('a stopped recorded session with an unreconciled claim is not replaced', async () => {
    recordSession('drs_dead');
    const ledgerRoot = join(tmpHome, 'machine-eas');
    await recordEasSessionClaim(
      {
        sessionId: 'drs_dead',
        name: 'stim-wt',
        platform: 'ios',
        workspaceRoot: root,
        workspaceHome: tmpHome,
        stateFile: workspaceStateFile(root),
      },
      ledgerRoot,
    );
    const exec = mockExec({
      outputs: {
        'simulator:get': JSON.stringify({ id: 'drs_dead', name: 'stim-wt', status: 'STOPPED' }),
        sim: CREATED,
      },
    });

    const booted = await remoteIosDeps(
      ctx({ easLedgerRoot: ledgerRoot, removeEasSessionClaim: () => false }),
    ).ensureBooted({});

    expect(booted.failed).toBe(true);
    expect(booted.code).toBe('STIM_REMOTE_SESSION_CLEANUP');
    expect(booted.reason).toMatch(/ownership claim.*could not be removed/i);
    expect(exec.calls.some((call) => call.args[0] === 'sim')).toBe(false);
    expect(JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8')).remoteDevice.sessionId).toBe('drs_dead');
  });

  test('an unowned live recorded session is neither stopped nor replaced', async () => {
    recordSession('drs_other');
    const exec = mockExec({
      outputs: {
        'simulator:get': JSON.stringify({ id: 'drs_other', name: 'other-tool', status: 'IN_PROGRESS' }),
        sim: CREATED,
      },
    });

    const booted = await remoteIosDeps(ctx()).ensureBooted({});

    expect(booted.failed).toBe(true);
    expect(exec.calls.some((c) => c.args[0] === 'simulator:stop')).toBe(false);
    expect(exec.calls.some((c) => c.args[0] === 'sim')).toBe(false);
    expect(JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8')).remoteDevice.sessionId).toBe('drs_other');
  });
});

describe("the alert Stim's own url open raises", () => {
  test('a dev-client launch accepts it, so the bundle can actually load', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteIosDeps(ctx({ existingDaemon: LOOPBACK, tunnelMode: 'off' }));
    await deps.ensureBooted({});
    await deps.launchIosApp({ udid: 'drs_42', bundleId: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' });
    const after = exec.calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(after).toContain('alert accept');
    expect(after.indexOf('alert accept')).toBeGreaterThan(after.indexOf('open com.example.app'));
  });
});

describe('a release-shaped remote launch', () => {
  test('android release launches the same way', async () => {
    const exec = mockExec({ outputs: { sim: CREATED } });
    const deps = remoteAndroidDeps(ctx());
    await deps.ensureDeviceBooted({});
    const r = await deps.launch({ serial: 'drs_42', packageName: 'com.example.app', metroPort: null });
    expect(r.ok).toBe(true);
    expect(exec.calls.find((c) => c.args[0] === 'open')?.args).not.toContain('--metro-host');
  });
});

test('concurrent recorded-session cleanup verifies the first stop before another cleanup proceeds', async () => {
  let stopped = false;
  let stops = 0;
  const exec = mockExec();
  exec.runFileAsync = async (_file, args) => {
    if (args[0] === 'simulator:get') {
      const status = stopped ? 'STOPPED' : 'IN_PROGRESS';
      await new Promise((resolve) => setTimeout(resolve, 10));
      return JSON.stringify({ id: 'drs_42', name: 'stim-wt', status });
    }
    if (args[0] === 'simulator:stop') {
      stops += 1;
      stopped = true;
      return JSON.stringify({ id: 'drs_42', status: 'STOPPED' });
    }
    return '';
  };
  const end = () =>
    endRecordedSession({
      root,
      sessionId: 'drs_42',
      easBin: '/bin/eas',
      lookupAgentDevice: () => '/bin/agent-device',
      ledgerRoot: tmpHome,
    });
  const results = await Promise.all([end(), end()]);
  expect(results).toEqual([
    { status: 'torn-down', reason: undefined },
    { status: 'torn-down', reason: undefined },
  ]);
  expect(stops).toBe(1);
});
