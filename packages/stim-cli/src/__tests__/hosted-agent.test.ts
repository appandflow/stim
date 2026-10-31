import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceHostMachineCredential } from '@stim-cli/core/state';
import { agentAccess } from '../device-host/hosted-agent.ts';

const SESSION = '12345678-1234-4234-8234-123456789abc';
const GRANT = {
  driver: 'agent-device',
  path: `/device-host/agent/${SESSION}/`,
  token: 's'.repeat(43),
  scope: SESSION,
  lease: {
    tenant: `stim.${SESSION}`,
    runId: SESSION,
    clientId: 'agent',
    backend: 'ios-instance',
    deviceKey: 'ios:mobile:12345678-1234-1234-1234-123456789ABC',
  },
};
const LOCAL: DeviceHostMachineCredential = {
  machine: 'local:10.0.0.92',
  transport: 'local',
  address: '10.0.0.92',
  state: 'approved',
  requestedAt: '2026-10-27T00:00:00.000Z',
  serverKey: 'S'.repeat(43),
  deviceId: 'client',
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-hosted-agent-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('a local network machine without a relay gets no agent control and the reason', async () => {
  const notes: string[] = [];
  const reason =
    'The Metro supervisor does not relay agent control to local:10.0.0.92. Run stim stop; stim start, then retry.';
  expect(await agentAccess(join(dir, 'agent.json'), LOCAL, GRANT, (line) => notes.push(line), 'ios', reason)).toEqual({
    driver: 'none',
    setting: 'hosting.agentDriver',
  });
  expect(notes).toEqual([reason]);
  expect(existsSync(join(dir, 'agent-device-remote.json'))).toBe(false);
});
