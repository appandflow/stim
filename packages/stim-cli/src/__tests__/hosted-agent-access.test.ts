import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAgentAccess } from '../device-host/hosted-agent.ts';

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
