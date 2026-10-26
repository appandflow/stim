import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 2;
const QUIET_BRANCH_DAYS = 7;
const DEFAULT_BRANCH = 'main';
const REPO = process.env.GITHUB_REPOSITORY || 'appandflow/stim';

export function parseClaimBranches(body) {
  const line = body.replace(/^\s*Claimed:\s*/i, '').split('\n')[0];
  const names = line
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s[\u2014\u2013-]\s|[.;](?:\s|$)/)[0]
    .split(',')
    .map((piece) =>
      piece
        .trim()
        .split(/\s+/)[0]
        .replace(/^[`*_]+|[`*_.,;:]+$/g, ''),
    )
    .filter((name, index) => name && (index === 0 || name.includes('/')));
  return [...new Set(names)];
}

const stamp = (comment) => Date.parse(comment.createdAt);

function latestClaim(comments) {
  let claim = null;
  for (const c of comments) {
    if (/^\s*Claimed:/i.test(c.body) && (!claim || stamp(c) >= stamp(claim))) claim = c;
  }
  if (!claim) return null;
  const released = comments.some((c) => /^\s*Released:/i.test(c.body) && stamp(c) > stamp(claim));
  return { claim, released };
}

function openPrsFor(issue, branchNames, openPrs) {
  const mention = new RegExp(`#${issue.number}(?!\\d)`);
  return openPrs.filter(
    (pr) =>
      branchNames.includes(pr.headRefName) ||
      pr.closes.includes(issue.number) ||
      mention.test(`${pr.title}\n${pr.body}`),
  );
}

/**
 * issues: [{ number, title, url, comments: [{ createdAt, body }] }]
 * openPrs: [{ number, isDraft, title, body, headRefName, closes: [issueNumber] }]
 * branches: Map<name, committedDate> for every branch on origin
 */
export function classifyClaims({ issues, openPrs, branches, now, days = DEFAULT_DAYS }) {
  const thresholdMs = days * DAY_MS;
  const records = [];
  for (const issue of issues) {
    const found = latestClaim(issue.comments);
    if (!found) continue;
    const claimedAt = Date.parse(found.claim.createdAt);
    const ageMs = now - claimedAt;
    const claimBranches = parseClaimBranches(found.claim.body).map((name) => ({
      name,
      onOrigin: branches.has(name),
      lastCommit: branches.get(name) ?? null,
    }));
    const prs = openPrsFor(
      issue,
      claimBranches.map((b) => b.name),
      openPrs,
    ).map((pr) => pr.number);
    let status = 'stale';
    if (found.released) status = 'released';
    else if (prs.length > 0) status = 'has-pr';
    else if (ageMs <= thresholdMs) status = 'fresh';
    else if (claimBranches.some((b) => b.lastCommit && now - Date.parse(b.lastCommit) <= thresholdMs)) {
      status = 'active-branch';
    }
    records.push({
      issue: issue.number,
      title: issue.title,
      url: issue.url,
      claimedAt: found.claim.createdAt,
      ageDays: Math.round((ageMs / DAY_MS) * 10) / 10,
      branches: claimBranches,
      prs,
      status,
    });
  }
  return records;
}

export function reviewBranchNames({ records, openPrs, now }) {
  const withPr = new Set(openPrs.map((pr) => pr.headRefName));
  const names = new Map();
  for (const record of records) {
    for (const b of record.branches) {
      if (!b.onOrigin || withPr.has(b.name) || names.has(b.name)) continue;
      if (now - Date.parse(b.lastCommit) <= QUIET_BRANCH_DAYS * DAY_MS) continue;
      names.set(b.name, { branch: b.name, issue: record.issue, lastCommit: b.lastCommit });
    }
  }
  return [...names.values()];
}

export function releaseComment(record) {
  const branches =
    record.branches.length === 0
      ? 'The claim names no branch.'
      : record.branches
          .map((b) =>
            b.onOrigin
              ? `Branch ${b.name} is still on origin, last commit ${b.lastCommit.slice(0, 10)}.`
              : `Branch ${b.name} is not on origin.`,
          )
          .join('\n');
  return [
    `Released: stale claim, ${record.ageDays} days old (${record.claimedAt.slice(0, 10)}), with no open pull request for this issue.`,
    branches,
    'Posted by scripts/stale-claims.mjs. Comment `Claimed: <branch>` to take the issue.',
  ].join('\n');
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

const branchLabel = (b) => `${b.name} (${b.onOrigin ? 'on origin' : 'not on origin'})`;

export function formatReport({ records, review, days }) {
  const stale = records.filter((r) => r.status === 'stale');
  const counts = Object.entries(Object.groupBy(records, (r) => r.status))
    .map(([status, list]) => `${list.length} ${status}`)
    .join(', ');
  const parts = [`${records.length} claims: ${counts || 'none'}. Stale means older than ${days} days.`];
  if (stale.length > 0) {
    parts.push(
      renderTable(
        ['ISSUE', 'AGE', 'BRANCHES', 'TITLE'],
        stale.map((r) => [`#${r.issue}`, `${r.ageDays}d`, r.branches.map(branchLabel).join(', ') || '-', r.title]),
      ),
    );
  }
  if (review.length > 0) {
    parts.push(
      `Branches for a human to review or delete (claimed, no open pull request, no commit in ${QUIET_BRANCH_DAYS} days, ahead of ${DEFAULT_BRANCH}):`,
      renderTable(
        ['BRANCH', 'ISSUE', 'LAST COMMIT', 'AHEAD'],
        review.map((r) => [r.branch, `#${r.issue}`, r.lastCommit.slice(0, 10), String(r.aheadBy)]),
      ),
    );
  }
  return parts.join('\n\n');
}

const cell = (text) => text.replaceAll('|', '\\|');

function formatMarkdown({ records, review, days, released }) {
  const stale = records.filter((r) => r.status === 'stale');
  const lines = [
    '## Stale issue claims',
    '',
    `${records.length} claims, ${stale.length} older than ${days} days with no open pull request. Released ${released.length}.`,
  ];
  if (stale.length > 0) {
    lines.push('', '| Issue | Age | Branches | Released |', '| --- | --- | --- | --- |');
    for (const r of stale) {
      const branches = r.branches.map(branchLabel).join(', ') || '-';
      lines.push(
        `| #${r.issue} ${cell(r.title)} | ${r.ageDays}d | ${cell(branches)} | ${released.includes(r.issue) ? 'yes' : 'no'} |`,
      );
    }
  }
  if (review.length > 0) {
    lines.push(
      '',
      '### Branches for a human to review or delete',
      '',
      '| Branch | Issue | Last commit | Ahead |',
      '| --- | --- | --- | --- |',
    );
    for (const r of review) lines.push(`| ${r.branch} | #${r.issue} | ${r.lastCommit.slice(0, 10)} | ${r.aheadBy} |`);
  }
  return `${lines.join('\n')}\n`;
}

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function pages(connection, fields) {
  const [owner, name] = REPO.split('/');
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      data: ${connection} { pageInfo { hasNextPage endCursor } nodes { ${fields} } }
    }
  }`;
  const nodes = [];
  let cursor = null;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const out = JSON.parse(gh(args));
    const data = out.data?.repository?.data;
    if (out.errors || !data) throw new Error(`GraphQL ${connection} failed: ${JSON.stringify(out.errors ?? out)}`);
    nodes.push(...data.nodes);
    if (!data.pageInfo.hasNextPage) return nodes;
    cursor = data.pageInfo.endCursor;
  }
}

function fetchState() {
  const issues = pages(
    'issues(states: OPEN, first: 50, after: $cursor)',
    'number title url comments(last: 100) { nodes { createdAt body } }',
  ).map((i) => Object.assign(i, { comments: i.comments.nodes }));
  const openPrs = pages(
    'pullRequests(states: OPEN, first: 50, after: $cursor)',
    'number isDraft title body headRefName closingIssuesReferences(first: 20) { nodes { number } }',
  ).map((pr) => Object.assign(pr, { closes: pr.closingIssuesReferences.nodes.map((n) => n.number) }));
  const branches = new Map(
    pages(
      'refs(refPrefix: "refs/heads/", first: 100, after: $cursor)',
      'name target { ... on Commit { committedDate } }',
    ).map((ref) => [ref.name, ref.target.committedDate]),
  );
  return { issues, openPrs, branches };
}

function aheadBy(branch) {
  const path = `repos/${REPO}/compare/${DEFAULT_BRANCH}...${encodeURIComponent(branch)}?per_page=1`;
  return Number(gh(['api', path, '--jq', '.ahead_by']));
}

function claimUnchanged(record) {
  const out = gh([
    'api',
    '--paginate',
    `repos/${REPO}/issues/${record.issue}/comments`,
    '--jq',
    '.[] | {createdAt: .created_at, body: .body}',
  ]);
  const comments = out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const found = latestClaim(comments);
  return Boolean(found) && !found.released && found.claim.createdAt === record.claimedAt;
}

function postRelease(record) {
  gh(['api', `repos/${REPO}/issues/${record.issue}/comments`, '-f', `body=${releaseComment(record)}`]);
}

function main() {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
      days: { type: 'string', default: String(DEFAULT_DAYS) },
    },
  });
  const days = Number(values.days);
  if (!(days > 0)) throw new Error(`--days must be a positive number, got ${JSON.stringify(values.days)}`);

  const now = Date.now();
  const state = fetchState();
  const records = classifyClaims({ ...state, now, days });
  const released = [];
  let failed = 0;
  if (values.release) {
    for (const record of records.filter((r) => r.status === 'stale')) {
      try {
        if (!claimUnchanged(record)) {
          console.error(`skipped #${record.issue}: its claim changed since the scan`);
          continue;
        }
        postRelease(record);
        released.push(record.issue);
        console.error(`released #${record.issue}`);
      } catch (error) {
        failed += 1;
        console.error(`could not release #${record.issue}: ${error.message}`);
      }
    }
  }

  let review = [];
  try {
    review = reviewBranchNames({ records, openPrs: state.openPrs, now })
      .map((c) => Object.assign(c, { aheadBy: aheadBy(c.branch) }))
      .filter((c) => c.aheadBy > 0);
  } catch (error) {
    failed += 1;
    console.error(`could not list branches to review: ${error.message}`);
  }

  const report = { days, claims: records, branchesToReview: review, released };
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport({ records, review, days }));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatMarkdown({ records, review, days, released }));
  }
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
