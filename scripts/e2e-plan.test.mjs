import { describe, expect, it } from 'vitest';
import { planSuites } from './e2e-plan.mjs';

describe('native e2e plan', () => {
  it('runs the smoke on every platform for a push to main', () => {
    expect(planSuites({ eventName: 'push', labels: [] })).toEqual({
      ios: ['smoke'],
      android: ['smoke'],
      windows: ['smoke'],
    });
  });

  it('runs the nightly loop on every platform', () => {
    expect(planSuites({ eventName: 'schedule', labels: [] })).toEqual({
      ios: ['loop'],
      android: ['loop'],
      windows: ['loop'],
    });
  });

  it('dispatch runs the suite input where the platform supports it', () => {
    expect(planSuites({ eventName: 'workflow_dispatch', labels: [], suite: 'pool' })).toEqual({
      ios: ['pool'],
      android: [],
      windows: [],
    });
    expect(planSuites({ eventName: 'workflow_dispatch', labels: [], suite: 'all' })).toEqual({
      ios: ['loop', 'caches', 'pool'],
      android: ['loop', 'caches'],
      windows: ['loop'],
    });
  });

  it('dispatch refuses a suite it does not know', () => {
    expect(() => planSuites({ eventName: 'workflow_dispatch', labels: [], suite: 'nightly' })).toThrow(
      'unknown suite input',
    );
  });

  it('an unlabeled pull request runs nothing', () => {
    expect(planSuites({ eventName: 'pull_request', labels: ['bug', 'e2e-native'] })).toEqual({
      ios: [],
      android: [],
      windows: [],
    });
  });

  it.each(['review: ai-approved', 'area: repo', 'e2e-native'])(
    'adding %s does not rerun an already-requested native matrix',
    (changedLabel) => {
      expect(
        planSuites({ eventName: 'pull_request', action: 'labeled', changedLabel, labels: ['e2e-all', changedLabel] }),
      ).toEqual({
        ios: [],
        android: [],
        windows: [],
      });
    },
  );

  it('adding a native suite label still runs the union of requested suites', () => {
    expect(
      planSuites({
        eventName: 'pull_request',
        action: 'labeled',
        changedLabel: 'e2e-caches',
        labels: ['e2e-pool', 'e2e-caches'],
      }),
    ).toEqual({
      ios: ['caches', 'pool'],
      android: ['caches'],
      windows: [],
    });
  });

  it('pull request labels union and are filtered per platform', () => {
    expect(planSuites({ eventName: 'pull_request', labels: ['e2e-smoke'] })).toEqual({
      ios: ['smoke'],
      android: ['smoke'],
      windows: ['smoke'],
    });
    expect(planSuites({ eventName: 'pull_request', labels: ['e2e-pool', 'e2e-caches', 'e2e-smoke'] })).toEqual({
      ios: ['smoke', 'caches', 'pool'],
      android: ['smoke', 'caches'],
      windows: ['smoke'],
    });
    expect(
      planSuites({
        eventName: 'pull_request',
        action: 'labeled',
        changedLabel: 'e2e-all',
        labels: ['e2e-all', 'e2e-loop'],
      }),
    ).toEqual({
      ios: ['loop', 'caches', 'pool'],
      android: ['loop', 'caches'],
      windows: ['loop'],
    });
  });

  it('refuses an event it has no rule for', () => {
    expect(() => planSuites({ eventName: 'release', labels: [] })).toThrow('unsupported event');
  });
});
