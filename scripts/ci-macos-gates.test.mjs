import { outputs, selectGates } from './ci-macos-gates.mjs';

const all = [
  'macos_unit=true',
  'native_process_inspection=true',
  'native_process_inspection_os=["macos-15","windows-latest"]',
];

test.each([
  [
    'a docs-only change',
    ['docs/testing.md', 'README.md', 'website/docs/intro.md', 'apps/desktop/README.md'],
    false,
    false,
  ],
  ['a Linux-only script', ['scripts/e2e-plan.mjs', '.github/workflows/mobile.yml'], false, false],
  ['a package source file', ['packages/stim-cli/src/api.ts'], true, false],
  ['the core package', ['packages/core/process-identity.ts'], true, true],
  ['a Darwin-gated benchmark test', ['scripts/agent-benchmark/runner-isolation.test.mjs'], true, false],
  ['an e2e file the process job runs', ['test/e2e/native-cleanup.e2e.js'], true, true],
  ['the harness the process job imports', ['test/e2e/native/assertions.mjs'], true, true],
  ['the lockfile', ['pnpm-lock.yaml'], true, true],
  ['the CI workflow', ['.github/workflows/ci.yml'], true, true],
])('%s', (_name, files, macosUnit, nativeProcessInspection) => {
  expect(selectGates(files)).toEqual({ macosUnit, nativeProcessInspection });
});

const diffing = (before, files) => (args) =>
  args[0] !== 'diff' ? '' : args.at(-2) === before ? files : 'packages/core/wrong-range.ts\0';

test('a pull request changing only docs leaves only the Windows process job', () => {
  expect(outputs({ GITHUB_EVENT_NAME: 'pull_request' }, diffing('HEAD^1', 'docs/testing.md\0README.md\0'))).toEqual([
    'macos_unit=false',
    'native_process_inspection=false',
    'native_process_inspection_os=["windows-latest"]',
  ]);
});

test('a push diffs against the previous main commit', () => {
  const env = { GITHUB_EVENT_NAME: 'push', BEFORE_SHA: 'abc123' };
  expect(outputs(env, diffing('abc123', 'docs/testing.md\0'))).toEqual([
    'macos_unit=false',
    'native_process_inspection=false',
    'native_process_inspection_os=["windows-latest"]',
  ]);
  expect(outputs(env, diffing('abc123', 'packages/core/index.ts\0'))).toEqual(all);
});

test.each([
  ['a manual dispatch', { GITHUB_EVENT_NAME: 'workflow_dispatch' }, () => 'docs/x.md\0'],
  ['a push with no previous commit', { GITHUB_EVENT_NAME: 'push', BEFORE_SHA: '0'.repeat(40) }, () => 'docs/x.md\0'],
  [
    'a diff that cannot be computed',
    { GITHUB_EVENT_NAME: 'pull_request' },
    () => {
      throw new Error('bad revision');
    },
  ],
])('%s runs every macOS job', (_name, env, git) => {
  expect(outputs(env, git)).toEqual(all);
});
