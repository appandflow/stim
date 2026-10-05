import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHostRoot, hostedAppArea } from '@stim-cli/core/state';
import { hostedAgentDriverFinding, inspectHostedAgentDriver } from '../device-host/agent-driver.ts';
import { getConfigPath } from '../workspace/config.ts';

test('notes hosted macOS apps only while no driver is configured', () => {
  expect(hostedAgentDriverFinding(undefined, 1)).toMatchObject({
    level: 'note',
    title: 'A hosted macOS app runs with no agent driver',
    fix: expect.stringContaining('hosting.agentDriver agent-device'),
  });
  expect(hostedAgentDriverFinding('none', 2)?.title).toBe('2 hosted macOS apps run with no agent driver');
  expect(hostedAgentDriverFinding('none', 0)).toBeNull();
  expect(hostedAgentDriverFinding('agent-device', 3)).toBeNull();
});

describe('reading the journal', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-agent-driver-'));
    process.env.STIM_HOME = home;
  });
  afterEach(() => {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const id = (suffix: number) => `12345678-1234-1234-1234-12345678900${suffix}`;
  const session = (suffix: number, extra: object = {}) => ({
    platform: 'macos',
    workspace: '/client/worktree',
    slot: 'default',
    attempt: 'first',
    id: id(suffix),
    client: 'client',
    state: 'ready',
    appSlot: suffix,
    appAttempt: 'app',
    device: { architecture: 'arm64', macosVersion: '27.0', appSlot: suffix },
    createdAt: new Date().toISOString(),
    ...extra,
  });
  const receipt = (suffix: number, state: string) => {
    const area = hostedAppArea(id(suffix), 'app');
    mkdirSync(area, { recursive: true });
    writeFileSync(
      join(area, 'receipt.json'),
      JSON.stringify({
        session: id(suffix),
        attempt: 'app',
        bundleId: 'dev.stim.fixture',
        mode: 'release',
        manifest: { sha256: 'a'.repeat(64), size: 10 },
        state,
        launched: true,
      }),
    );
  };
  const journal = (...sessions: object[]) => {
    mkdirSync(deviceHostRoot(), { recursive: true });
    writeFileSync(join(deviceHostRoot(), 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  };

  test('counts only ready macOS sessions whose app is installed', () => {
    expect(inspectHostedAgentDriver()).toBeNull();
    journal(session(1), session(2), session(3, { state: 'stopping' }), session(4, { appAttempt: undefined }));
    receipt(1, 'installed');
    receipt(2, 'installing');
    receipt(3, 'installed');
    expect(inspectHostedAgentDriver()?.title).toBe('A hosted macOS app runs with no agent driver');
    receipt(2, 'installed');
    expect(inspectHostedAgentDriver()?.title).toBe('2 hosted macOS apps run with no agent driver');
  });

  test('stays quiet when the setting names a driver or the journal is unreadable', () => {
    journal(session(1));
    receipt(1, 'installed');
    expect(inspectHostedAgentDriver()).not.toBeNull();
    writeFileSync(getConfigPath(), JSON.stringify({ hosting: { agentDriver: 'agent-device' } }));
    expect(inspectHostedAgentDriver()).toBeNull();
    writeFileSync(getConfigPath(), '{}');
    writeFileSync(join(deviceHostRoot(), 'sessions.json'), '{');
    expect(inspectHostedAgentDriver()).toBeNull();
  });
});
