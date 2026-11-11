import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runContract } from '../transport-kit.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../../../../test/fixtures/plugins/${name}`, import.meta.url));

const run = (
  baseDir: string,
  options: Record<string, unknown> = {},
  reference = './index.mjs',
  expose?: { port: number },
) => runContract('transport', { reference, baseDir, options, env: {}, ...(expose ? { expose } : {}) });
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
    'close settles',
  ]);
});

test('expose and unexpose run only when the caller asks for them', async () => {
  const asked = await run(fixture('transport-fixture'), { exposable: true }, './index.mjs', { port: 7787 });
  expect(failed(asked)).toEqual({});
  expect(asked.map(({ name }) => name)).toContain(
    'expose answers the port and whether it is reachable, and unexpose settles',
  );
  const broken = failed(
    await run(fixture('transport-fixture'), { exposable: true, break: 'expose' }, './index.mjs', { port: 7787 }),
  );
  expect(Object.keys(broken)).toEqual(['expose answers the port and whether it is reachable, and unexpose settles']);
});

test('an event or an identity that cannot cross the thread boundary fails its check', async () => {
  const event = failed(await run(fixture('transport-fixture'), { break: 'event' }));
  expect(Object.keys(event)).toEqual(['watch delivers { addresses } events and stops']);
  const identity = failed(await run(fixture('transport-fixture'), { break: 'identify' }));
  expect(Object.keys(identity)).toEqual(['identify answers null or an identity for a peer it does not know']);
});

test('a capability that is not a function, or a watch that returns no stop function, fails', async () => {
  expect(await run(fixture('transport-fixture'), { break: 'member' })).toEqual([
    { name: 'the module loads', passed: false, error: expect.stringContaining('bindAddresses that is not a function') },
  ]);
  const watch = failed(await run(fixture('transport-fixture'), { break: 'watch' }));
  expect(Object.keys(watch)).toEqual(['watch delivers { addresses } events and stops']);
});

test('a module that requires stim at runtime does not load', async () => {
  expect(await run(fixture('transport-fixture'), { break: 'require' })).toEqual([
    { name: 'the module loads', passed: false, error: expect.stringContaining("imports 'stim/plugin' at runtime") },
  ]);
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

test('the bundled local transport passes through the kit', async () => {
  expect(failed(await run(fixture('transport-fixture'), { addresses: [] }, 'builtin:local'))).toEqual({});
});

test('a bundled transport the kit does not run fails to load with the reason', async () => {
  expect(await run(fixture('transport-fixture'), {}, 'builtin:tailscale')).toEqual([
    { name: 'the module loads', passed: false, error: expect.stringContaining("watches this Mac's Tailscale") },
  ]);
});
