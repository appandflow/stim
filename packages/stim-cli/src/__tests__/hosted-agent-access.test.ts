import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentAccess, removeAgentAccess } from '../device-host/hosted-agent.ts';

vi.mock('@stim-cli/agent-driver-agent-device', () => {
  throw new Error('broken install');
});

test('removes a placement agent token file even when its driver package does not load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-agent-access-'));
  try {
    const remote = join(dir, 'agent-device-remote.json');
    writeFileSync(remote, '{"daemonAuthToken":"secret"}');
    await removeAgentAccess(join(dir, 'placement.json'));
    expect(existsSync(remote)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a driver package that does not load says so and how to recover, not that the host is unsupported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-agent-access-'));
  const session = '12345678-1234-4234-8234-123456789abc';
  const notes: string[] = [];
  try {
    const access = await agentAccess(
      join(dir, 'placement.json'),
      {
        machine: 'tailscale:worker',
        transport: 'tailscale',
        address: 'worker.example.ts.net',
        state: 'approved',
        requestedAt: '2026-10-27T00:00:00.000Z',
        serverKey: 'S'.repeat(43),
        deviceId: 'client',
      },
      {
        driver: 'agent-device',
        path: `/device-host/agent/${session}/`,
        token: 's'.repeat(43),
        scope: session,
        lease: { tenant: `stim.${session}`, runId: session, clientId: 'agent', deviceKey: 'dev.app@4242' },
      },
      (line) => notes.push(line),
    );
    expect(access).toEqual({ driver: 'none', setting: 'hosting.agentDriver' });
    expect(notes).toEqual([expect.stringMatching(/could not load its agent-device driver .*Update or reinstall Stim/)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
