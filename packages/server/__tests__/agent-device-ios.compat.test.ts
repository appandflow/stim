import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { inject } from 'vitest';
import { AgentDeviceDriver } from '../src/agent-device-driver.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    agentDeviceSource: string;
  }
}

const fixture = vi.hoisted(() => ({ script: '' }));

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: (_command: string, _args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const result = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', fixture.script],
      {
        ...options,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    const state = options.env.AGENT_DEVICE_DAEMON_POLICY!.replace('policy.json', '');
    writeFileSync(join(state, 'result.json'), result);
    writeFileSync(
      join(state, 'daemon.json'),
      JSON.stringify({
        pid: 777777,
        httpPort: 4311,
        token: 'fixture-private',
        policyDigest: JSON.parse(result).digest,
      }),
    );
    const child = Object.assign(new EventEmitter(), {
      pid: 777778,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => child.stdout.write('Proxy listening at http://127.0.0.1:4310\n'));
    return child;
  },
  execFile: (_command: string, ...args: unknown[]) => (args.at(-1) as (error: null, stdout: string) => void)(null, ''),
}));
vi.mock('@stim-cli/core/process-identity', async (original) => {
  const actual = await original<typeof import('@stim-cli/core/process-identity')>();
  return {
    ...actual,
    captureProcessIdentity: (pid: number) =>
      [777777, 777778].includes(pid) ? { ok: true, token: 'fixture-process' } : actual.captureProcessIdentity(pid),
    inspectProcessIdentity: (record: Parameters<typeof actual.inspectProcessIdentity>[0]) =>
      record && typeof record.pid === 'number' && [777777, 777778].includes(record.pid)
        ? 'gone'
        : actual.inspectProcessIdentity(record),
    waitForProcessExit: async () => true,
  };
});
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  request: (_options: unknown, answer: (response: IncomingMessage) => void) =>
    Object.assign(new EventEmitter(), {
      end: () =>
        queueMicrotask(() =>
          answer(
            Object.assign(Readable.from([JSON.stringify({ upstream: { leaseBackends: ['ios-instance'] } })]), {
              statusCode: 200,
              headers: {},
            }) as IncomingMessage,
          ),
        ),
      destroy: () => {},
    }),
}));

const SESSION = '11111111-1111-4111-8111-111111111111';
const UDID = '22222222-abcd-4222-8222-222222222222';

test('upstream accepts the hosted policy, agrees on its digest and filters inventory in an isolated process', async () => {
  const source = inject('agentDeviceSource').trim();
  if (!source)
    throw new Error(
      'Compatibility requires STIM_AGENT_DEVICE_SOURCE pointing to agent-device source with dependencies installed.',
    );
  const home = mkdtempSync(join(tmpdir(), 'stim-ios-policy-compat-'));
  process.env.STIM_HOME = home;
  const stateDir = join(home, 'agent');
  const bin = join(home, 'agent-device.mjs');
  writeFileSync(bin, '');
  fixture.script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.env.STIM_AGENT_DEVICE_SOURCE;
    const { parseDaemonPolicy } = await import(pathToFileURL(join(root, 'src/daemon-policy-file.ts')));
    const { assertDaemonPolicyAdmitsRequest, restrictDeviceInventoryToDaemonPolicy } =
      await import(pathToFileURL(join(root, 'src/daemon/daemon-policy.ts')));
    const { resolveDeviceClaimRoot } =
      await import(pathToFileURL(join(root, 'src/daemon/device/device-claim-paths.ts')));
    const file = process.env.AGENT_DEVICE_DAEMON_POLICY;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const policy = parseDaemonPolicy(raw, file);
    assert.throws(() => parseDaemonPolicy({ ...raw, commands: { allow: ['rotate'] } }, 'invalid'));
    assertDaemonPolicyAdmitsRequest(policy, { command: 'devices' });
    const devices = [{ id: raw.devices.allow[0].udid }, { id: 'foreign-simulator' }];
    const gateways = restrictDeviceInventoryToDaemonPolicy({
      localOnly: { discover: async () => devices },
      providerFirst: { discoverWithSource: async () => ({ devices, source: 'local' }) },
    }, policy);
    console.log(JSON.stringify({
      digest: policy.digest,
      local: await gateways.localOnly.discover(),
      provider: await gateways.providerFirst.discover(),
      workspace: process.cwd(),
      claims: resolveDeviceClaimRoot(),
    }));
  `;
  const driver = new AgentDeviceDriver({
    env: {
      ...process.env,
      STIM_AGENT_DEVICE_BIN: bin,
      STIM_AGENT_DEVICE_SOURCE: resolve(source),
      AGENT_DEVICE_CLAIMS_DIR: join(home, 'host-claims'),
    },
    stateDir,
    claimRoot: join(home, 'claims'),
    ios: { session: SESSION, udid: UDID },
  });
  try {
    await driver.start();
    await expect(
      driver.issue({ client: 'c', session: SESSION, udid: UDID, bundleId: 'dev.app' }),
    ).resolves.toMatchObject({
      lease: { deviceKey: `ios:mobile:${UDID}`, backend: 'ios-instance' },
    });
    expect(JSON.parse(readFileSync(join(stateDir, 'result.json'), 'utf8'))).toMatchObject({
      local: [{ id: UDID }],
      provider: [{ id: UDID }],
      workspace: '/',
      claims: join(stateDir, 'device-claims'),
    });
  } finally {
    await driver.stop();
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
