import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRoute, newAgentToken, runAgentDriverContract } from '@stim-cli/agent-driver';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-agent-device-contract-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('agent-device passes the agent driver contract', async () => {
  const session = '11111111-1111-4111-8111-111111111111';
  const results = await runAgentDriverContract({
    id: 'agent-device',
    load: () => import('../index.ts'),
    unavailableInput: {
      env: { HOME: root, STIM_AGENT_DEVICE_BIN: join(root, 'missing', 'agent-device') },
      stateDir: join(root, 'agent-device'),
      claimRoot: join(root, 'agent-device.claims'),
    },
    app: { client: 'client', session, bundleId: 'dev.example.app.hosted1', pid: 4242 },
    clientGrant: {
      driver: 'agent-device',
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
  expect(results.filter((result) => !result.passed)).toEqual([]);
});
