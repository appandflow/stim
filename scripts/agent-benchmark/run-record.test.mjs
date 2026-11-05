import { describe, expect, it } from 'vitest';
import { completedCleanupRecord, durableRunRecord } from './run-record.mjs';

const hashes = { events: 'events', settingsPng: 'settings', transcript: 'transcript' };
const valid = { valid: true, invalidReasons: [], evidenceSha256: hashes, collectedAt: 'first' };

describe('durable benchmark run records', () => {
  it('retains verified native compatibility after cleanup while recalculating the audit and timings', () => {
    const previous = {
      ...valid,
      runId: 'crash-run',
      stage: 'sol-android-launch-error',
      runner: 'codex',
      model: 'sol',
      arm: 'stim',
      variant: 'launch-crash',
      worktree: '/worktree/run',
      nativeCompatibility: { valid: true, manifestSha256: 'manifest' },
      proof: { valid: true, kind: 'launch-crash-source-repair', sourceSha256: 'source' },
      evidenceSha256: { ...hashes, proof: 'source', recording: 'video' },
      dispatchToDiagnosisSeconds: 120,
    };
    const next = {
      ...previous,
      valid: false,
      nativeCompatibility: {
        valid: false,
        reason: 'run worktree missing for compatibility validation',
        manifestSha256: 'manifest',
      },
      invalidReasons: ['launch-crash-source-missing', 'native-compatibility-changed-or-unverified'],
      proof: { valid: false, reason: 'launch-crash-source-missing' },
      evidenceSha256: { ...previous.evidenceSha256, proof: null },
      dispatchToDiagnosisSeconds: 100,
      collectedAt: 'second',
    };
    expect(durableRunRecord(previous, next, true)).toMatchObject({
      valid: true,
      invalidReasons: [],
      nativeCompatibility: previous.nativeCompatibility,
      proof: previous.proof,
      dispatchToDiagnosisSeconds: 100,
      collectedAt: 'second',
    });
    expect(
      durableRunRecord(previous, { ...next, invalidReasons: [...next.invalidReasons, 'timeout'] }, true),
    ).toMatchObject({ valid: false, invalidReasons: ['timeout'] });
    expect(durableRunRecord(previous, next)).toBe(next);
    for (const key of ['runId', 'stage', 'runner', 'model', 'arm', 'variant', 'worktree']) {
      expect(durableRunRecord(previous, { ...next, [key]: 'changed' }, true).invalidReasons).toContain(
        'native-compatibility-changed-or-unverified',
      );
    }
    for (const key of ['events', 'settingsPng', 'transcript', 'recording']) {
      for (const value of ['changed', null]) {
        expect(
          durableRunRecord(previous, { ...next, evidenceSha256: { ...next.evidenceSha256, [key]: value } }, true)
            .invalidReasons,
        ).toContain('native-compatibility-changed-or-unverified');
      }
    }
    for (const nativeCompatibility of [
      { ...next.nativeCompatibility, manifestSha256: 'changed' },
      { valid: false, reason: 'run worktree missing for compatibility validation' },
      { ...next.nativeCompatibility, reason: 'agent-device compatibility package changed' },
    ]) {
      expect(durableRunRecord(previous, { ...next, nativeCompatibility }, true).invalidReasons).toContain(
        'native-compatibility-changed-or-unverified',
      );
    }
    for (const prior of [
      null,
      { ...previous, valid: false },
      { ...previous, nativeCompatibility: { valid: false, manifestSha256: 'manifest' } },
      { ...previous, evidenceSha256: { ...previous.evidenceSha256, proof: 'changed' } },
    ]) {
      expect(durableRunRecord(prior, next, true).invalidReasons).toContain(
        'native-compatibility-changed-or-unverified',
      );
    }
    const readiness = { ...previous, variant: 'javascript' };
    const changedProof = {
      ...next,
      variant: 'javascript',
      proof: { valid: true },
      evidenceSha256: { ...previous.evidenceSha256, proof: 'changed' },
    };
    expect(durableRunRecord(readiness, changedProof, true).invalidReasons).toContain(
      'native-compatibility-changed-or-unverified',
    );
  });

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
