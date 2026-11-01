import { redactArgv, redactCommandLine } from '../state/trace.ts';

test('redactArgv finishes quickly on a huge argument made of flag-like text', () => {
  const started = performance.now();
  redactArgv([`--${'ab-'.repeat(60_000)}`, `-${'-'.repeat(20_000)}`]);
  redactCommandLine(`--${'ab-'.repeat(60_000)}`);
  expect(performance.now() - started).toBeLessThan(2000);
});
