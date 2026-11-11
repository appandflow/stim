import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { agentRoute, newAgentToken } from '@stim-cli/agent-driver';
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
