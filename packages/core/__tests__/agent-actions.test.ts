import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentActionReader } from '../state/agent-actions.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-archived-actions-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('archived sessions retain actions and request starts without live device claims', () => {
  const sessionsDir = join(home, 'archive', 'removed', 'agent-device', 'sessions');
  const read = createAgentActionReader({ sessionsDirs: [sessionsDir] });
  expect(read()).toEqual([]);
  cpSync(join(import.meta.dirname, '../../stim-cli/src/__tests__/fixtures/agent-device/sessions'), sessionsDir, {
    recursive: true,
  });
  const records = read();
  expect(records).toHaveLength(11);
  expect(records).toContainEqual(
    expect.objectContaining({
      src: 'agent',
      event: 'agent_action',
      platform: 'ios',
      deviceId: 'AD45387C-599D-4EDB-A62B-18176FF3A2A7',
      command: 'press',
      msg: 'Tapped (201, 542)',
      ts: Date.parse('2026-09-25T12:16:03.448Z'),
      startedAt: Date.parse('2026-09-25T12:15:57.453Z'),
    }),
  );
  const android = records.find((record) => record.msg === 'Failed open: DEVICE_NOT_FOUND');
  expect(android).toMatchObject({
    src: 'agent',
    event: 'agent_failed',
    level: 'error',
    platform: 'android',
    command: 'open',
    session: 'and5012',
    startedAt: Date.parse('2026-09-13T01:56:45.575Z'),
  });
  expect(android).not.toHaveProperty('deviceId');
  expect(read()).toEqual([]);
});
