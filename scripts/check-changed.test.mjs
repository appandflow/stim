import { planChecks } from './check-changed.mjs';

const plan = (files, base = 'base', exists) => planChecks(files, base, 'linux', exists).map((argv) => argv.join(' '));

test('a prose change formats, and an integration test uses the integration runner', () => {
  expect(plan(['docs/testing.md'])).toEqual(['pnpm run format:check']);
  const file = 'packages/server/__tests__/changed.integration.test.ts';
  const commands = plan([file]);
  expect(commands).toContain(`pnpm run test:integration ./${file}`);
  expect(commands.some((command) => command.includes('test:unit'))).toBe(false);
});

test('a deleted file or generated fixture selects the full test stages', () => {
  const cases = [
    plan(['packages/server/__tests__/old.test.ts'], 'base', () => false),
    plan(['apps/mobile/mock-server/fixtures/status.json']),
    plan([], null),
  ];
  for (const commands of cases) {
    expect(commands).toContain('pnpm run test:unit');
    expect(commands).toContain('pnpm run test:integration');
  }
});

test('a shared core change checks consumers outside the root Vitest suite', () => {
  const commands = plan(['packages/core/state/status.ts']);
  expect(commands).toContain('pnpm run test:unit --changed base --passWithNoTests');
  expect(commands).toContain('pnpm run rpc:check');
  expect(commands).toContain('pnpm --filter stim-mobile run test');
  expect(commands).toContain('pnpm --filter stim-demo-server test');
});

test('includes a regression that invokes the changed script as a subprocess', () => {
  const file = 'scripts/ci-unit-test-files.mjs';
  expect(plan([file], 'base', (path) => [file, 'scripts/ci-unit-test-files.test.mjs'].includes(path))).toContain(
    'pnpm run test:unit ./scripts/ci-unit-test-files.test.mjs',
  );
});

test('a shared mobile fixture checks both consumers without rewriting locale files', () => {
  const commands = plan(['apps/mobile/mock-server/payloads.mjs']);
  expect(commands).toContain('pnpm --filter stim-demo-server test');
  expect(commands).toContain('pnpm --filter stim-mobile run test');
  expect(commands).not.toContain('pnpm --filter stim-mobile run intl:check');
});

test('a benchmark input outside its script directory selects the benchmark suite', () => {
  expect(plan(['website/src/data/benchmark-matrix.json'])).toContain('pnpm run test:bench');
  expect(plan(['scripts/launch-crash-benchmark.mjs'])).toContain('pnpm run test:bench');
});
