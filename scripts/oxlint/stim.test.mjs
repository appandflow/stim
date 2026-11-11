import { fileURLToPath } from 'node:url';
import { RuleTester } from 'oxlint/plugins-dev';
import plugin from './stim.mjs';

const tester = new RuleTester();

tester.run('package-fence', plugin.rules['package-fence'], {
  valid: [
    {
      code: "import '../state/index.js';",
      filename: fileURLToPath(new URL('../../packages/core/src/example.ts', import.meta.url)),
    },
    {
      code: "import '@stim-cli/core';",
      filename: fileURLToPath(new URL('../../packages/cache/index.ts', import.meta.url)),
    },
    {
      code: "type T = import('../state/index.js').T;",
      filename: fileURLToPath(new URL('../../packages/core/src/example.ts', import.meta.url)),
    },
    {
      code: "type T = typeof import('@stim-cli/core');",
      filename: fileURLToPath(new URL('../../packages/cache/index.ts', import.meta.url)),
    },
    {
      code: "new URL('../../other/asset.bin', location.url);",
      filename: fileURLToPath(new URL('../../packages/core/src/example.ts', import.meta.url)),
    },
  ],
  invalid: [
    "import '../../cache/index.js';",
    "export { value } from '../../cache/index.js';",
    "export * from '../../cache/index.js';",
    "import('../../cache/index.js');",
    "type T = import('../../cache/index.js').T;",
    "type T = typeof import('../../cache/index.js');",
    "require('../../cache/index.js');",
    "require.resolve('../../cache/index.js');",
    "new URL('../../cache/asset.bin', import.meta.url);",
    "import '../../../scripts/example.mjs';",
    "import '../../core-other/index.js';",
  ].map((code) => ({
    code,
    filename: fileURLToPath(new URL('../../packages/core/src/example.ts', import.meta.url)),
    errors: 1,
  })),
});

tester.run('directive-reason', plugin.rules['directive-reason'], {
  valid: [
    '// oxlint-disable-next-line no-console -- the CLI prints here\nconsole.log(1);',
    '/* eslint-disable no-console -- a script */',
    '// eslint-enable no-console',
    '// eslint-disable-next-line no-console ---- a longer separator',
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
    "process.emitWarning('relative path', { code: 'STIM_RELATIVE_PATH' });",
  ],
  invalid: [
    { code: "fail({ code: 'STIM_NO_DEVICE', message: 'm' });", errors: 1 },
    { code: "fail({ code: 'STIM_NO_DEVICE' as const });", filename: 'refusal.ts', errors: 1 },
  ],
});

const lazy = [{ modules: ['@stim-cli/transport-tailscale'] }];
const allowSmall = [{ modules: ['@stim-cli/transport-tailscale'], allow: ['@stim-cli/transport-tailscale/small'] }];
const net = fileURLToPath(new URL('../../packages/server/src/example.ts', import.meta.url));

tester.run('static-imports', plugin.rules['static-imports'], {
  valid: [
    { code: "import type { T } from '@stim-cli/transport-tailscale';", options: lazy, filename: net },
    { code: "import { type T } from '@stim-cli/transport-tailscale';", options: lazy, filename: net },
    { code: "export type { T } from '@stim-cli/transport-tailscale';", options: lazy, filename: net },
    { code: "const load = () => import('@stim-cli/transport-tailscale');", options: lazy, filename: net },
    { code: "import { value } from '@stim-cli/transport-local';", options: lazy, filename: net },
    { code: "import { value } from '@stim-cli/transport-tailscale-extra';", options: lazy, filename: net },
    { code: "import { value } from '@stim-cli/transport-tailscale/small';", options: allowSmall, filename: net },
  ],
  invalid: [
    "import { value } from '@stim-cli/transport-tailscale';",
    "import manifest from '@stim-cli/transport-tailscale';",
    "import manifest from '@stim-cli/transport-tailscale/package.json' with { type: 'json' };",
    "import { value, type T } from '@stim-cli/transport-tailscale';",
    "export { value } from '@stim-cli/transport-tailscale';",
    "export * from '@stim-cli/transport-tailscale';",
  ]
    .map((code) => ({ code, options: lazy, filename: net, errors: 1 }))
    .concat([
      {
        code: "import { value } from '@stim-cli/transport-tailscale/small/deeper';",
        options: allowSmall,
        filename: net,
        errors: 1,
      },
    ]),
});
