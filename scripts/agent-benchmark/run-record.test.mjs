import { describe, expect, it } from 'vitest';
import { completedCleanupRecord, durableRunRecord } from './run-record.mjs';

const hashes = { events: 'events', settingsPng: 'settings', transcript: 'transcript' };
const valid = { valid: true, invalidReasons: [], evidenceSha256: hashes, collectedAt: 'first' };

describe('durable benchmark run records', () => {
  it('retains verified crash repair evidence after cleanup without retaining a stale audit verdict', () => {
    const previous = {
      runId: 'crash-run',
      variant: 'launch-crash',
      valid: false,
      invalidReasons: ['launch-crash-initial-launch-missing'],
      proof: { valid: true, kind: 'launch-crash-source-repair', sourceSha256: 'source' },
      evidenceSha256: { ...hashes, proof: 'source' },
    };
    const next = {
      runId: 'crash-run',
      variant: 'launch-crash',
      valid: false,
      invalidReasons: ['launch-crash-source-missing'],
      proof: { valid: false, reason: 'launch-crash-source-missing' },
      evidenceSha256: hashes,
    };
    expect(durableRunRecord(previous, next, true)).toMatchObject({
      valid: true,
      proof: previous.proof,
      invalidReasons: [],
    });
    expect(
      durableRunRecord(previous, { ...next, invalidReasons: [...next.invalidReasons, 'timeout'] }, true),
    ).toMatchObject({ valid: false, invalidReasons: ['timeout'] });
    expect(durableRunRecord(previous, next)).toBe(next);
    for (const changed of [
      { ...next, runId: 'different-run' },
      { ...next, evidenceSha256: { ...hashes, events: 'changed' } },
    ])
      expect(durableRunRecord(previous, changed, true)).toBe(changed);
    expect(durableRunRecord({ ...previous, evidenceSha256: { ...hashes, proof: 'different' } }, next, true)).toBe(next);
  });
  it('requires a successful recorded worktree cleanup', () => {
    expect(completedCleanupRecord({ cleanedAt: 'now', actions: ['stim worktree remove --force'] })).toBe(true);
    expect(completedCleanupRecord({ cleanedAt: 'now', actions: ['verified agent-device sessions empty'] })).toBe(false);
    expect(
      completedCleanupRecord({
        cleanedAt: 'now',
        actions: ['remove worktree worktree/run', 'failed: remove worktree worktree/run: busy'],
      }),
    ).toBe(false);
  });

  it('preserves a valid integrity-matched record after live worktree cleanup', () => {
    const recollected = {
      valid: false,
      invalidReasons: ['launch-crash-worktree-missing', 'worktree-evidence-missing'],
      evidenceSha256: hashes,
      collectedAt: 'second',
    };
    expect(durableRunRecord(valid, recollected, true)).toBe(valid);
  });

  it('does not preserve a record across changed evidence or a stricter audit failure', () => {
    const changed = {
      valid: false,
      invalidReasons: ['launch-crash-worktree-missing'],
      evidenceSha256: { ...hashes, events: 'changed' },
    };
    const auditFailure = {
      valid: false,
      invalidReasons: ['launch-crash-pre-capture-command-not-allowed'],
      evidenceSha256: hashes,
    };
    const missingSource = {
      valid: false,
      invalidReasons: ['launch-crash-source-missing'],
      evidenceSha256: hashes,
    };
    const missingEdit = {
      valid: false,
      invalidReasons: ['source-edit-missing'],
      evidenceSha256: hashes,
    };
    expect(durableRunRecord(valid, changed)).toBe(changed);
    expect(durableRunRecord(valid, auditFailure)).toBe(auditFailure);
    expect(durableRunRecord(valid, missingSource)).toBe(missingSource);
    expect(durableRunRecord(valid, missingEdit)).toBe(missingEdit);
    expect(durableRunRecord(valid, missingSource, true)).toBe(valid);
    expect(durableRunRecord(valid, missingEdit, true)).toBe(valid);
  });
});
