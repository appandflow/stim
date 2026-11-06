import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPlugin } from '../plugin-loader.ts';

test('discovers the plugin manifest above nested module-type boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-plugin-loader-'));
  try {
    const entryDir = join(root, 'dist', 'esm');
    mkdirSync(entryDir, { recursive: true });
    const manifest = { stimPlugin: { kinds: { 'cache-provider': 1 } } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
    writeFileSync(join(entryDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(entryDir, 'index.js'), 'export {};');

    expect(projectPlugin('./dist/esm/index.js', root).manifest()).toEqual(manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
