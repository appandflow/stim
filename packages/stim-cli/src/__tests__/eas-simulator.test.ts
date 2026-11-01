import assert from 'node:assert';

import { findOrphanedOwnedSessions, inspectSessionForTeardown, remoteDaemonFrom } from '../engine/eas-simulator.ts';

describe('stored-session teardown authorization', () => {
  test('authorizes an owned live session', () => {
    expect(
      inspectSessionForTeardown(JSON.stringify({ id: 'drs_42', name: 'stim-wt', status: 'IN_PROGRESS' }), 'drs_42'),
    ).toEqual({ action: 'stop', name: 'stim-wt', status: 'IN_PROGRESS' });
  });

  test('refuses an unowned live session', () => {
    const result = inspectSessionForTeardown(
      JSON.stringify({ id: 'drs_42', name: 'other-tool', status: 'IN_PROGRESS' }),
      'drs_42',
    );
    expect(result.action).toBe('refused');
    assert(result.action === 'refused');
    expect(result.reason).toContain('not owned by Stim');
  });

  test.each(['STOPPED', 'ERRORED'])('treats verified terminal status %s as already stopped', (status) => {
    expect(inspectSessionForTeardown(JSON.stringify({ id: 'drs_42', name: 'stim-wt', status }), 'drs_42')).toEqual({
      action: 'already-stopped',
      name: 'stim-wt',
      status,
    });
  });

  test.each([
    ['another tool', 'other-tool'],
    ['no name', undefined],
  ])('refuses a terminal session owned by %s', (_owner, name) => {
    const result = inspectSessionForTeardown(JSON.stringify({ id: 'drs_42', name, status: 'STOPPED' }), 'drs_42');
    expect(result.action).toBe('refused');
    assert(result.action === 'refused');
    expect(result.reason).toContain('not owned by Stim');
  });

  test('refuses malformed output', () => {
    const result = inspectSessionForTeardown('not json', 'drs_42');
    expect(result.action).toBe('refused');
    assert(result.action === 'refused');
    expect(result.reason).toContain('valid JSON');
  });

  test('refuses a response for a different session', () => {
    const result = inspectSessionForTeardown(
      JSON.stringify({ id: 'drs_other', name: 'stim-wt', status: 'IN_PROGRESS' }),
      'drs_42',
    );
    expect(result.action).toBe('refused');
    assert(result.action === 'refused');
    expect(result.reason).toContain('drs_other');
  });

  test('refuses an unknown status', () => {
    const result = inspectSessionForTeardown(
      JSON.stringify({ id: 'drs_42', name: 'stim-wt', status: 'PAUSED' }),
      'drs_42',
    );
    expect(result.action).toBe('refused');
    assert(result.action === 'refused');
    expect(result.reason).toContain('PAUSED');
  });
});

describe('remoteDaemonFrom', () => {
  test('a config missing its token is unusable, not partially usable', () => {
    expect(
      remoteDaemonFrom({
        __typename: 'AgentDeviceRunSessionRemoteConfig',
        agentDeviceRemoteSessionUrl: 'https://x',
      }),
    ).toBeNull();
  });
});

describe('findOrphanedOwnedSessions', () => {
  const scope = '/work/current-expo-project';

  test('deduplicates a repeated listed session ID', () => {
    const session = { id: 'same', name: 'stim-same', status: 'IN_PROGRESS', platform: 'IOS' };
    const result = findOrphanedOwnedSessions({
      sessions: [session, session],
      recordedSessionIds: [],
      projectScope: scope,
    });
    expect(result.orphaned.map((entry) => entry.id)).toEqual(['same']);
  });

  test('does not classify terminal or unknown statuses as orphan candidates', () => {
    const result = findOrphanedOwnedSessions({
      sessions: [
        { id: 'stopped', name: 'stim-stopped', status: 'STOPPED', platform: 'IOS' },
        { id: 'paused', name: 'stim-paused', status: 'PAUSED', platform: 'IOS' },
      ],
      recordedSessionIds: [],
      projectScope: scope,
    });
    expect(result.orphaned).toEqual([]);
    expect(result.notices.join('\n')).toMatch(/PAUSED/);
  });

  test('reports malformed owned entries and refuses to infer their identity', () => {
    const result = findOrphanedOwnedSessions({
      sessions: [
        { name: 'stim-missing-id', status: 'IN_PROGRESS' },
        { id: 'missing-name', status: 'IN_PROGRESS' },
        null,
      ],
      recordedSessionIds: [],
      projectScope: scope,
    });
    expect(result.orphaned).toEqual([]);
    expect(result.notices.length).toBeGreaterThan(0);
  });
});
