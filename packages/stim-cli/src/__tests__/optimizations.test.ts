import { compilerCacheFallbackMessage, resolveOptimizations } from '../optimizations.ts';

import assert from 'node:assert';

test('a toolchain path that is not absolute degrades without claiming a cache the build will not run', () => {
  const relative = { android: { compilerCache: 'none', casToolchain: 'relative.json' } };
  const options = resolveOptimizations({ optimizations: relative }, {});
  expect(options.android.compilerCache).toBe('none');
  const fallback = options.android.compilerCacheFallback;
  assert(fallback);
  expect(fallback.key).toBe('optimizations.android.casToolchain');
  expect(compilerCacheFallbackMessage({ fallback, compilerCache: 'none', file: '/home/.stim/config.json' })).toBe(
    'optimizations.android.casToolchain in /home/.stim/config.json is "relative.json", which is not an absolute ' +
      'path to a toolchain JSON manifest. Android builds use no compiler cache, because ' +
      'optimizations.android.compilerCache is "none".',
  );
});
