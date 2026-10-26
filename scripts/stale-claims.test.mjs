import { describe, expect, it } from 'vitest';
import { classifyClaims, parseClaimBranches, releaseComment, reviewBranchNames } from './stale-claims.mjs';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();
const comment = (days, body) => ({ createdAt: daysAgo(days), body });
const issue = (number, comments) => ({ number, title: `issue ${number}`, url: '', comments });

function classify(issues, { openPrs = [], branches = new Map(), days } = {}) {
  return classifyClaims({ issues, openPrs, branches, now: NOW, days });
}

describe('claim branch parsing', () => {
  it.each([
    ['Claimed: a/1-x', ['a/1-x']],
    ['Claimed: a/1-x, b/1-y, c/1-z', ['a/1-x', 'b/1-y', 'c/1-z']],
    ['Claimed: feat/2598-phase1 (phase 1: report-only engine, hook, checks)', ['feat/2598-phase1']],
    ['Claimed: fix/3951-evidence — resuming the existing worktree, prior probes', ['fix/3951-evidence']],
    ['Claimed: feat/2451-signing. The maintainer approved the patch, continuing', ['feat/2451-signing']],
    ['Claimed: release/1.26.0\nmore detail, with commas', ['release/1.26.0']],
    ['Claimed: 4405-offload-xcode-posix-path', ['4405-offload-xcode-posix-path']],
    ['Claimed: `fix/1-a`, **fix/1-b**', ['fix/1-a', 'fix/1-b']],
  ])('%j', (body, expected) => {
    expect(parseClaimBranches(body)).toEqual(expected);
  });
});

describe('claim classification', () => {
  const claim = (days, branch = 'fix/1-a') => comment(days, `Claimed: ${branch}`);

  it('keeps a claim newer than the threshold and flags one older than it', () => {
    const [fresh] = classify([issue(1, [claim(1.9)])]);
    const [stale] = classify([issue(1, [claim(2.1)])]);
    expect([fresh.status, stale.status]).toEqual(['fresh', 'stale']);
  });

  it('honors a custom threshold', () => {
    expect(classify([issue(1, [claim(3)])], { days: 5 })[0].status).toBe('fresh');
  });

  it('does not count prose that merely quotes Claimed: as a claim', () => {
    const quoted = comment(10, 'Claim status: the `Claimed: fix/1-a` comment is old');
    expect(classify([issue(1, [quoted])])).toEqual([]);
  });

  it('treats a later Released: as ending the claim and a later claim as starting a new one', () => {
    const released = classify([issue(1, [claim(10), comment(9, 'Released: gave up')])]);
    expect(released[0].status).toBe('released');
    const reclaimed = classify([issue(1, [claim(10), comment(9, 'Released: gave up'), claim(0.5, 'fix/1-b')])]);
    expect(reclaimed[0]).toMatchObject({ status: 'fresh', branches: [{ name: 'fix/1-b' }] });
  });

  it('ignores a Released: comment that predates the latest claim', () => {
    expect(classify([issue(1, [comment(20, 'Released: old'), claim(10)])])[0].status).toBe('stale');
  });

  it('uses the newest claim even when comments arrive out of order', () => {
    expect(classify([issue(1, [claim(0.5, 'fix/1-b'), claim(10)])])[0].branches[0].name).toBe('fix/1-b');
  });

  it('does not flag an issue with an open pull request on the claimed branch, a closing link, or a mention', () => {
    const pr = { number: 7, isDraft: true, title: 'x', body: '', headRefName: 'fix/1-a', closes: [] };
    const byBranch = classify([issue(1, [claim(30)])], { openPrs: [pr] })[0];
    const byClose = classify([issue(1, [claim(30)])], { openPrs: [{ ...pr, headRefName: 'other', closes: [1] }] })[0];
    const byMention = classify([issue(1, [claim(30)])], {
      openPrs: [{ ...pr, headRefName: 'other', body: 'Part of #1.' }],
    })[0];
    expect([byBranch, byClose, byMention].map((r) => [r.status, r.prs])).toEqual([
      ['has-pr', [7]],
      ['has-pr', [7]],
      ['has-pr', [7]],
    ]);
  });

  it('does not mistake #12 or #1234 in a pull request for issue #1', () => {
    const pr = { number: 7, isDraft: false, title: 'fixes #12 and #1234', body: '', headRefName: 'other', closes: [] };
    expect(classify([issue(1, [claim(30)])], { openPrs: [pr] })[0].status).toBe('stale');
  });

  it('keeps a claim whose branch has a commit inside the threshold', () => {
    const branches = new Map([['fix/1-a', daysAgo(1)]]);
    expect(classify([issue(1, [claim(30)])], { branches })[0].status).toBe('active-branch');
  });

  it('reports whether each claimed branch is on origin', () => {
    const branches = new Map([['a/1-x', daysAgo(30)]]);
    const [found] = classify([issue(1, [comment(30, 'Claimed: a/1-x, b/1-y')])], { branches });
    expect(found.branches.map((b) => [b.name, b.onOrigin])).toEqual([
      ['a/1-x', true],
      ['b/1-y', false],
    ]);
    expect(found.status).toBe('stale');
  });
});

const record = (number, ...branches) => ({ issue: number, branches });
const b = (name, days) => ({ name, onOrigin: days !== null, lastCommit: days === null ? null : daysAgo(days) });

describe('branches to review', () => {
  it('lists claimed branches that are on origin, quiet for 7 days and have no open pull request', () => {
    const records = [
      record(1, b('quiet', 8), b('recent', 6), b('gone', null), b('has-pr', 30)),
      record(2, b('quiet', 8)),
    ];
    const openPrs = [{ headRefName: 'has-pr' }];
    expect(reviewBranchNames({ records, openPrs, now: NOW })).toEqual([
      { branch: 'quiet', issue: 1, lastCommit: daysAgo(8) },
    ]);
  });
});

describe('release comment', () => {
  it('starts with Released: so the next scan and other agents read the claim as ended', () => {
    const [stale] = classify([issue(1, [comment(30, 'Claimed: a/1-x, b/1-y')])], {
      branches: new Map([['a/1-x', daysAgo(20)]]),
    });
    const body = releaseComment(stale);
    expect(body).toMatch(/^Released: stale claim, 30 days old/);
    expect(body).toContain('Branch a/1-x is still on origin');
    expect(body).toContain('Branch b/1-y is not on origin');
    const after = classify([issue(1, [comment(30, 'Claimed: a/1-x'), comment(0, body)])]);
    expect(after[0].status).toBe('released');
  });
});
