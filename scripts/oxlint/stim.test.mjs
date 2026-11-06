import { RuleTester } from 'oxlint/plugins-dev';
import plugin from './stim.mjs';

const tester = new RuleTester();

tester.run('directive-reason', plugin.rules['directive-reason'], {
  valid: [
    '// oxlint-disable-next-line no-console -- the CLI prints here\nconsole.log(1);',
    '/* eslint-disable no-console -- a script */',
    '// eslint-enable no-console',
    '// eslint-disabled is prose, not a directive',
  ],
  invalid: [
    { code: '// oxlint-disable-next-line no-console\nconsole.log(1);', errors: 1 },
    { code: '/* eslint-disable */', errors: 1 },
    { code: '// eslint-disable-line -- no rule named', errors: 1 },
  ],
});

tester.run('no-snapshot', plugin.rules['no-snapshot'], {
  valid: ["expect(value).toMatchInlineSnapshot('1');", 'expect(value).toEqual({ a: 1 });'],
  invalid: [
    { code: 'expect(value).toMatchSnapshot();', errors: 1 },
    { code: "await expect(text).toMatchFileSnapshot('out.json');", errors: 1 },
    { code: `expect(value).toMatchInlineSnapshot(\`${'\n'.repeat(20)}\`);`, errors: 1 },
  ],
});

tester.run('refusal-remedy', plugin.rules['refusal-remedy'], {
  valid: [
    "throw new StimError({ code: 'STIM_NO_DEVICE', message: 'm', remedy: 'r' });",
    "fail({ code: 'STIM_NO_DEVICE', ...details });",
    "failedResult({ code: 'STIM_NO_DEVICE', diagnostics: [{ message: 'm', remedy: 'r' }] });",
    "fail({ code: 'STIM_BAD_ARG', message: 'm' }, { code: 'STIM_CANCELLED' }, { code: 'STIM_CI_CANCELLED' });",
    "const options = { code: 'EEXIST' };",
  ],
  invalid: [
    { code: "fail({ code: 'STIM_NO_DEVICE', message: 'm' });", errors: 1 },
    { code: "fail({ code: 'STIM_NO_DEVICE' as const });", filename: 'refusal.ts', errors: 1 },
  ],
});
