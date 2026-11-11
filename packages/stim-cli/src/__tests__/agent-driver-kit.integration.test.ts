import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { agentRoute, createAgentDriverHost, newAgentToken, type AgentDriverProcess } from '@stim-cli/agent-driver';
import {
  markClaimChildPending,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { isJsonObject as isRecord } from '@stim-cli/core/state';
import { captureProcessIdentity } from '@stim-cli/core/process-identity';
import { startKitWorker, type KitWorker } from '../kit-host.ts';
import { runContract } from '../transport-kit.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../../../test/fixtures/plugins/${name}`, import.meta.url));
const agentDevice = fileURLToPath(new URL('../../../agent-driver-agent-device', import.meta.url));
const session = '11111111-1111-4111-8111-111111111111';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-agent-driver-kit-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = (baseDir: string, id: string, reference = './index.mjs') =>
  runContract('agent-driver', {
    reference,
    baseDir,
    id,
    unavailableInput: {
      env: { HOME: root, STIM_AGENT_DEVICE_BIN: join(root, 'missing', 'agent-device') },
      stateDir: join(root, id),
      claimRoot: join(root, `${id}.claims`),
    },
    app: { client: 'client', session, bundleId: 'dev.example.app.hosted1', pid: 4242 },
    clientGrant: {
      driver: id,
      path: agentRoute(session),
      token: newAgentToken(),
      scope: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      lease: {
        tenant: `stim.${session}`,
        runId: session,
        clientId: 'agent',
        deviceKey: 'dev.example.app.hosted1@4242',
      },
    },
  });
const failed = (results: Awaited<ReturnType<typeof run>>) =>
  Object.fromEntries(results.filter((result) => !result.passed).map(({ name, error }) => [name, error]));

test('a driver whose members answer in cloneable data and refuse with the unavailable code passes', async () => {
  const results = await run(fixture('driver-fixture'), 'driver-fixture');
  expect(failed(results)).toEqual({});
  expect(results.map(({ name }) => name)).toContain(
    'start refuses with agent-driver-unavailable when the tool is missing, then stops',
  );
  expect(results.map(({ name }) => name)).toContain('client access refuses a grant for another driver');
});

test('a driver that imports stim at runtime does not load', async () => {
  expect(await run(fixture('driver-fixture-imports-stim'), 'imports-stim')).toEqual([
    {
      name: 'the module loads',
      passed: false,
      error: expect.stringMatching(/^the module did not load: .*imports 'stim\/plugin' at runtime/),
    },
  ]);
});

test('the agent-device driver passes through the kit', async () => {
  expect(failed(await run(agentDevice, 'agent-device', './index.ts'))).toEqual({});
});

describe.skipIf(process.platform === 'win32')('host members through the kit worker', () => {
  let worker: KitWorker;
  const children: number[] = [];

  beforeEach(async () => {
    const started = await startKitWorker({
      href: pathToFileURL(join(fixture('driver-host-fixture'), 'index.mjs')).href,
      factory: 'createAgentDriver',
      input: { env: {}, stateDir: join(root, 'state'), claimRoot: join(root, 'claims') },
      capabilities: ['start', 'stop', 'issue', 'revoke', 'target', 'onExit'],
      idMember: 'name',
      host: { ...createAgentDriverHost() },
    });
    if ('unavailable' in started) throw new Error(started.unavailable);
    worker = started;
  });

  afterEach(async () => {
    await worker.terminate();
    for (const pid of children.splice(0))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
  });

  const use = (member: string, ...args: unknown[]) => worker.call('use', member, ...args);

  async function sleeper(): Promise<{ pid: number; record: AgentDriverProcess; exited: Promise<unknown> }> {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const { pid } = child;
    if (pid === undefined) throw new Error('sleep did not start');
    children.push(pid);
    const captured = captureProcessIdentity(pid);
    if (!captured.ok) throw new Error(captured.reason);
    return { pid, record: { pid, token: captured.token }, exited: once(child, 'exit') };
  }

  function claimHeldBy(claims: string, label: string, owner: AgentDriverProcess): ClaimHandle {
    const { acquired } = tryAcquireClaim({
      root: claims,
      mode: 'exclusive',
      label,
      owner: { pid: owner.pid, processToken: owner.token },
    });
    if (!acquired) throw new Error(`${claims} is held`);
    return acquired;
  }

  function claimOf(value: unknown): { claim: string; path: string } {
    if (isRecord(value) && typeof value.claim === 'string' && typeof value.path === 'string')
      return { claim: value.claim, path: value.path };
    throw new Error(`no claim was taken: ${JSON.stringify(value)}`);
  }

  test('take, a held claim, release, and an unknown claim id', async () => {
    const claims = join(root, 'daemon.claims');
    const result = await use('claims.take', claims, 'fixture daemon');
    expect(result).toEqual({ claim: expect.any(String), path: expect.stringContaining(claims), previousChild: null });
    const taken = claimOf(result);
    expect(await use('claims.take', claims, 'fixture daemon')).toEqual({ held: taken.path, waitingFor: null });
    expect(await use('claims.release', taken.claim)).toBe(true);
    await expect(use('claims.release', taken.claim)).rejects.toThrow(`This host holds no claim ${taken.claim}.`);
    expect(await use('claims.take', claims, 'fixture daemon')).toMatchObject({ claim: expect.any(String) });
    expect(await use('claims.removeCommand', taken.path)).toMatch(/^rm -f /);
  });

  test('a claim store the host cannot use refuses with the claim code and its whole remedy', async () => {
    const blocked = join(root, 'blocked.claims');
    writeFileSync(blocked, 'not a claim set');
    await expect(use('claims.take', blocked, 'fixture daemon')).rejects.toMatchObject({
      code: 'STIM_CLAIM_REFUSED',
      message: expect.stringContaining(`\n  mv -i '${blocked}'`),
    });
  });

  test('a captured child is recorded on the claim and stopped by identity', async () => {
    const child = await sleeper();
    const captured = await use('processes.capture', child.pid);
    expect(captured).toEqual(child.record);
    const { claim } = claimOf(await use('claims.take', join(root, 'child.claims'), 'fixture daemon'));
    await use('claims.childPending', claim);
    await use('claims.setChild', claim, captured);
    expect(await use('processes.inspect', captured)).toBe('same');
    expect(await use('processes.stop', captured, { group: false, steps: [['SIGTERM', 3000]] })).toBe(true);
    await child.exited;
    expect(['gone', 'different']).toContain(await use('processes.inspect', captured));
    expect(await use('processes.capture', child.pid)).toBeNull();
    await use('claims.clearChild', claim);
    expect(await use('claims.release', claim)).toBe(true);
  });

  test('stopStale stops the child of a claim whose owner is gone, and take reports a reaped child', async () => {
    const owner = await sleeper();
    const recorders = join(root, 'recorder.claims');
    const stale = claimHeldBy(recorders, 'fixture recorder', owner.record);
    const child = await sleeper();
    setClaimChild(stale, { pid: child.pid, processToken: child.record.token });
    const daemons = join(root, 'reaped.claims');
    const gone = claimHeldBy(daemons, 'fixture daemon', owner.record);
    setClaimChild(gone, { pid: child.pid, processToken: child.record.token });
    process.kill(owner.pid, 'SIGKILL');
    await owner.exited;
    expect(await use('claims.take', recorders, 'fixture recorder')).toEqual({ held: stale.path, waitingFor: null });
    await use('claims.stopStale', recorders, 'fixture recorder', { steps: [['SIGTERM', 3000]] });
    await child.exited;
    expect(await use('claims.take', recorders, 'fixture recorder')).toMatchObject({ claim: expect.any(String) });
    expect(await use('claims.take', daemons, 'fixture daemon')).toMatchObject({ previousChild: child.record });
  });

  test('stopStale keeps a claim whose child it cannot identify and names the command that removes it', async () => {
    const owner = await sleeper();
    const recorders = join(root, 'pending.claims');
    const stale = claimHeldBy(recorders, 'fixture recorder', owner.record);
    markClaimChildPending(stale);
    process.kill(owner.pid, 'SIGKILL');
    await owner.exited;
    await expect(use('claims.stopStale', recorders, 'fixture recorder', { steps: [['SIGTERM', 100]] })).rejects.toThrow(
      /^The fixture recorder is unresolved; its claim .+ was kept\. Once it is gone, clear it with: rm /,
    );
  });
});
