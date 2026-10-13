import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedAgentHost } from '../src/agent-driver.ts';
import { configuredAgentDriver } from '../src/agent-drivers.ts';

const { missing } = vi.hoisted(() => ({
  missing: '/Users/someone/Library/Application Support/Stim/node_modules/agent-device/dist/index.mjs',
}));

vi.mock('@stim-cli/agent-driver-agent-device', () => ({
  apiVersion: 1,
  id: 'agent-device',
  client: undefined,
  actions: undefined,
  createAgentDriver: () => {
    throw Object.assign(new Error(`Cannot find module '${missing}' imported from /Users/someone/stim/server.mjs`), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
  },
}));

let area: string;

beforeEach(() => {
  area = mkdtempSync(join(tmpdir(), 'stim-agent-driver-load-'));
});

afterEach(() => {
  rmSync(area, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test('a driver that fails to load gives the client a generic notice and logs the reason on the host', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const agents = new HostedAgentHost({
    resolve: () => configuredAgentDriver('agent-device', {}, area),
    nodeOf: () => 'node',
  });
  const access = await agents.appRunning({
    client: 'c',
    session: '11111111-1111-4111-8111-111111111111',
    bundleId: 'dev.example.app',
    pid: 7,
  });
  expect(access.grant).toEqual({ driver: 'none' });
  expect(access.notice).toContain('agent-device');
  expect(access.notice).not.toContain(missing);
  expect(access.notice).not.toContain('/Users/someone');
  expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain(missing);
  await agents.close();
});
