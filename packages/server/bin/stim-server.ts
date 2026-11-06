#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const floor = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node.slice(2);

const encode = (version: string): number =>
  version.split('.', 3).reduce((sum, part) => sum * 1000 + parseInt(part, 10), 0);

if (encode(process.versions.node) < encode(floor)) {
  process.stderr.write(
    `STIM_NODE_UNSUPPORTED: stim-server needs Node ${floor} or later; this is Node ${process.versions.node} at ${process.execPath}. To run stim-server where a project pins an older Node, see https://stim.appandflow.com/docs/requirements#older-node-pins\n`,
  );
  process.exitCode = 1;
} else {
  const manifest = createRequire(import.meta.url).resolve('stim/package.json');
  await import(pathToFileURL(join(dirname(manifest), 'dist/stim-server.mjs')).href);
}
