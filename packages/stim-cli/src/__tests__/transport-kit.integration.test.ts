import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runContract } from '../transport-kit.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../../../test/fixtures/plugins/${name}`, import.meta.url));
const local = fileURLToPath(new URL('../../../transport-local', import.meta.url));

const run = (baseDir: string, options: Record<string, unknown> = {}, reference = './index.mjs') =>
  runContract('transport', { reference, baseDir, options, env: {} });
const failed = (results: Awaited<ReturnType<typeof run>>) =>
  Object.fromEntries(results.filter((result) => !result.passed).map(({ name, error }) => [name, error]));

test('a transport whose members answer in cloneable data passes every check', async () => {
  const results = await run(fixture('transport-fixture'));
  expect(failed(results)).toEqual({});
  expect(results.map(({ name }) => name)).toEqual([
    'the module loads',
    'bindAddresses returns a list of address strings',
    'watch delivers { addresses } events and stops',
    'identify answers null or an identity for a peer it does not know',
    'resolve answers an endpoint or a reason',
    'close may be called twice',
  ]);
});

test('an event or an identity that cannot cross the thread boundary fails its check', async () => {
  const event = failed(await run(fixture('transport-fixture'), { break: 'event' }));
  expect(Object.keys(event)).toEqual(['watch delivers { addresses } events and stops']);
  const identity = failed(await run(fixture('transport-fixture'), { break: 'identify' }));
  expect(Object.keys(identity)).toEqual(['identify answers null or an identity for a peer it does not know']);
});

test('a module that imports stim at runtime does not load', async () => {
  const results = await run(fixture('transport-fixture-imports-stim'));
  expect(results).toEqual([
    {
      name: 'the module loads',
      passed: false,
      error: expect.stringMatching(/^the module did not load: .*imports 'stim\/plugin' at runtime/),
    },
  ]);
});

test('the local transport passes through the kit', async () => {
  expect(failed(await run(local, { addresses: [] }, './index.ts'))).toEqual({});
});
