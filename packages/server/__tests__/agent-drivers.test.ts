import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedAgentHost } from '../src/agent-driver.ts';
import { configuredAgentDriver, stoppingAgentDriver } from '../src/agent-drivers.ts';

let area: string;
const device = { session: '11111111-1111-4111-8111-111111111111', udid: '22222222-2222-4222-8222-222222222222' };

beforeEach(() => {
  area = mkdtempSync(join(tmpdir(), 'stim-agent-drivers-'));
});

afterEach(() => {
  rmSync(area, { recursive: true, force: true });
});

test('a setting naming no registered driver leaves the app without agent control and says why', async () => {
  const agents = new HostedAgentHost({
    resolve: () => configuredAgentDriver('missing-tool', {}, area),
    nodeOf: () => 'node',
  });
  expect(
    await agents.appRunning({ client: 'c', session: device.session, bundleId: 'dev.example.app', pid: 7 }),
  ).toEqual({
    grant: { driver: 'none' },
    notice: 'hosting.agentDriver names "missing-tool", which this stim-server has no driver for.',
  });
  await agents.close();
});

test('a stopping session tears down the driver whose claim root it has, whatever the setting says now', async () => {
  expect(await stoppingAgentDriver('missing-tool', {}, area, device)).toBeNull();
  expect(await stoppingAgentDriver('none', {}, area, device)).toBeNull();
  mkdirSync(join(area, 'agent-device.claims'));
  expect((await stoppingAgentDriver('none', {}, area, device))?.name).toBe('agent-device');
});
