import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

for (const [directory, bin] of [
  ['stim-cli', 'dist/cli.mjs'],
  ['server', 'dist/stim-server.mjs'],
]) {
  const root = `${repositoryRoot}packages/${directory}`;
  const floor = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).engines.node.replace('>=', '');
  const result = spawnSync(process.execPath, [`${root}/${bin}`, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 1, `${bin} must refuse Node ${process.versions.node}: ${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.startsWith('STIM_NODE_UNSUPPORTED: '), result.stderr);
  for (const fact of [floor, process.versions.node, process.execPath]) assert.ok(result.stderr.includes(fact), fact);
}
