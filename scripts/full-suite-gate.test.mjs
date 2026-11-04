import { findFullSuiteRun } from './full-suite-gate.mjs';

const sha = 'a'.repeat(40);
const run = (fields) => ({
  name: 'Full suite (native E2E)',
  path: '.github/workflows/full-suite.yml',
  event: 'workflow_dispatch',
  display_title: 'Full suite (native E2E)',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-04T01:00:00Z',
  html_url: 'https://example.test/run',
  ...fields,
});

test('a green dispatched run with the native E2E on the commit passes', () => {
  expect(findFullSuiteRun([run({})], sha)).toMatchObject({ html_url: 'https://example.test/run' });
});

test.each([
  ['another commit', { head_sha: 'b'.repeat(40) }],
  ['a failed run', { conclusion: 'failure' }],
  ['an unfinished run', { status: 'in_progress', conclusion: null }],
  ['a run without the native E2E', { display_title: 'Full suite' }],
  ['a nightly run', { event: 'schedule' }],
  ['a pull request run', { event: 'pull_request' }],
  ['another workflow', { name: 'CI', display_title: 'CI', path: '.github/workflows/ci.yml' }],
])('%s does not pass', (_name, fields) => {
  expect(findFullSuiteRun([run(fields)], sha)).toBeNull();
});

test('a later failed run does not cancel an earlier green run on the same commit', () => {
  const green = run({ created_at: '2026-11-04T01:00:00Z', html_url: 'https://example.test/green' });
  const red = run({ created_at: '2026-11-04T02:00:00Z', conclusion: 'failure' });
  expect(findFullSuiteRun([red, green], sha)?.html_url).toBe('https://example.test/green');
});
