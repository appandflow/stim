import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { agentRoute, createAgentDriverHost, newAgentToken, type AgentDriverProcess } from '@stim-cli/agent-driver';
import {
  markClaimChildPending,
  readClaimSet,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { isJsonObject as isRecord } from '@stim-cli/core/state';
import { captureProcessIdentity } from '@stim-cli/core/process-identity';
import { startKitWorker, type KitWorker } from '../kit-host.ts';
import { runContract } from '../transport-kit.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../../../test/fixtures/plugins/${name}`, import.meta.url));
const session = '11111111-1111-4111-8111-111111111111';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-agent-driver-kit-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = (baseDir: string, id?: string, reference = './index.mjs') =>
  runContract('agent-driver', {
    reference,
    baseDir,
    unavailableInput: {
      env: { HOME: root, STIM_AGENT_DEVICE_BIN: join(root, 'missing', 'agent-device') },
      stateDir: join(root, 'driver'),
      claimRoot: join(root, 'driver.claims'),
    },
    app: { client: 'client', session, bundleId: 'dev.example.app.hosted1', pid: 4242 },
    ...(id
      ? {
          id,
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
        }
      : {}),
  });
const failed = (results: Awaited<ReturnType<typeof run>>) =>
  Object.fromEntries(results.filter((result) => !result.passed).map(({ name, error }) => [name, error]));

test('a driver whose members answer in cloneable data and refuse with the unavailable code passes', async () => {
  const results = await run(fixture('driver-fixture'));
  expect(failed(results)).toEqual({});
  expect(results.map(({ name }) => name)).toContain(
    'start refuses with agent-driver-unavailable when the tool is missing, then stops',
  );
  expect(results.map(({ name }) => name)).toContain('client access refuses a grant for another driver');
});

test('a driver that imports stim at runtime does not load', async () => {
  expect(await run(fixture('driver-fixture-imports-stim'))).toEqual([
    {
      name: 'the module loads',
      passed: false,
      error: expect.stringMatching(/^the module did not load: .*imports 'stim\/plugin' at runtime/),
    },
  ]);
});

test('the bundled agent-device driver passes through the kit', async () => {
  expect(failed(await run(root, 'agent-device', 'builtin:agent-device'))).toEqual({});
});

test('a driver checked against an id it does not carry fails that check', async () => {
  expect(Object.keys(failed(await run(fixture('driver-fixture'), 'other-driver')))).toEqual([
    'the driver carries the module id',
    'client access names its file and keeps the token out of the command',
  ]);
});

describe.skipIf(process.platform === 'win32')('host members through the kit worker', () => {
  let worker: KitWorker;
  let state: string;
  const children: number[] = [];

  beforeEach(async () => {
    state = join(root, 'state');
    const scope = { stateDir: state, claimRoot: join(root, 'state.claims') };
    const { dispose, ...members } = createAgentDriverHost(scope);
    const started = await startKitWorker({
      href: pathToFileURL(join(fixture('driver-host-fixture'), 'index.mjs')).href,
      factory: 'createAgentDriver',
      input: { env: {}, ...scope },
      capabilities: ['start', 'stop', 'issue', 'revoke', 'target', 'onExit'],
      idMember: 'name',
      host: members,
      disposeHost: dispose,
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
    const claims = join(root, 'state.claims');
    const result = await use('claims.take', claims, 'fixture daemon');
    expect(result).toEqual({ claim: expect.any(String), path: expect.stringContaining(claims), previousChild: null });
    const taken = claimOf(result);
    expect(await use('claims.take', claims, 'fixture daemon')).toEqual({ held: taken.path, waitingFor: null });
    expect(await use('claims.release', taken.claim)).toBe(true);
    await expect(use('claims.release', taken.claim)).rejects.toThrow(`This host holds no claim ${taken.claim}.`);
    expect(await use('claims.take', join(state, 'recorder.claims'), 'fixture recorder')).toMatchObject({
      claim: expect.any(String),
    });
    expect(await use('claims.removeCommand', taken.path)).toMatch(/^rm -f /);
  });

  test('claims outside the driver state and identities the host did not capture are refused', async () => {
    const outside = join(root, 'elsewhere');
    mkdirSync(outside);
    mkdirSync(state);
    symlinkSync(outside, join(state, 'link'));
    for (const claims of [
      join(root, 'other.claims'),
      join(state, 'link', 'x.claims'),
      `${state}/link/../x.claims`,
      state,
      root,
    ])
      await expect(use('claims.take', claims, 'fixture daemon')).rejects.toThrow(
        `The claim root ${claims} is outside this driver's state.`,
      );
    await expect(
      use('claims.stopStale', join(root, 'other.claims'), 'fixture recorder', { steps: [['SIGINT', 100]] }),
    ).rejects.toThrow("is outside this driver's state.");
    const child = await sleeper();
    const { claim } = claimOf(await use('claims.take', join(state, 'a.claims'), 'fixture daemon'));
    for (const call of [
      use('processes.inspect', child.record),
      use('processes.stop', child.record, { group: false, steps: [['SIGTERM', 100]] }),
      use('claims.setChild', claim, child.record),
    ])
      await expect(call).rejects.toThrow(`This host did not capture process ${child.pid}.`);
    expect(await use('processes.inspect', await use('processes.capture', child.pid))).toBe('same');
    expect(await use('claims.take', join(state, '..foo.claims'), 'fixture daemon')).toMatchObject({
      claim: expect.any(String),
    });
  });

  test('a claim store the host cannot use refuses with the claim code and its whole remedy', async () => {
    mkdirSync(state);
    const blocked = join(state, 'blocked.claims');
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
    const { claim } = claimOf(await use('claims.take', join(state, 'child.claims'), 'fixture daemon'));
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
    const recorders = join(state, 'recorder.claims');
    const stale = claimHeldBy(recorders, 'fixture recorder', owner.record);
    const child = await sleeper();
    setClaimChild(stale, { pid: child.pid, processToken: child.record.token });
    const daemons = join(root, 'state.claims');
    const gone = claimHeldBy(daemons, 'fixture daemon', owner.record);
    setClaimChild(gone, { pid: child.pid, processToken: child.record.token });
    process.kill(owner.pid, 'SIGKILL');
    await owner.exited;
    expect(await use('claims.take', recorders, 'fixture recorder')).toEqual({ held: stale.path, waitingFor: null });
    await use('claims.stopStale', recorders, 'fixture recorder', { steps: [['SIGTERM', 3000]] });
    await child.exited;
    expect(await use('claims.take', recorders, 'fixture recorder')).toMatchObject({ claim: expect.any(String) });
    const reaped = await use('claims.take', daemons, 'fixture daemon');
    expect(reaped).toMatchObject({ previousChild: child.record });
    expect(['gone', 'different']).toContain(await use('processes.inspect', child.record));
  });

  test('stopStale keeps a claim whose child it cannot identify and names the command that removes it', async () => {
    const owner = await sleeper();
    const recorders = join(state, 'pending.claims');
    const stale = claimHeldBy(recorders, 'fixture recorder', owner.record);
    markClaimChildPending(stale);
    process.kill(owner.pid, 'SIGKILL');
    await owner.exited;
    await expect(use('claims.stopStale', recorders, 'fixture recorder', { steps: [['SIGTERM', 100]] })).rejects.toThrow(
      /^The fixture recorder is unresolved; its claim .+ was kept\. Once it is gone, clear it with: rm /,
    );
  });

  test('a terminated worker stops the children on its claims and releases them, even mid-call', async () => {
    const child = await sleeper();
    const stubborn = await sleeper();
    const claims = join(root, 'state.claims');
    const { claim } = claimOf(await use('claims.take', claims, 'fixture daemon'));
    await use('claims.childPending', claim);
    await use('claims.setChild', claim, await use('processes.capture', child.pid));
    const waiting = use('processes.stop', await use('processes.capture', stubborn.pid), {
      group: false,
      steps: [['SIGCONT', 20_000]],
    }).catch((error: unknown) => error);
    await worker.terminate();
    expect(await waiting).toMatchObject({ message: expect.stringContaining('the worker exited') });
    await child.exited;
    expect(worker.failures).toEqual([]);
    expect(readClaimSet(claims).live).toEqual([]);
  });

  test('a terminated worker keeps a claim whose child it cannot identify and reports it', async () => {
    const claims = join(root, 'state.claims');
    const { claim, path } = claimOf(await use('claims.take', claims, 'fixture daemon'));
    await use('claims.childPending', claim);
    await worker.terminate();
    expect(worker.failures).toEqual([
      `The fixture daemon is unresolved; its claim ${path} was kept. Once it is gone, clear it with: rm -f '${path}'`,
    ]);
    expect(readClaimSet(claims).live.map((holder) => holder.path)).toEqual([path]);
  });
});
