#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const floor = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node.slice(2);

const encode = (version: string): number =>
  version.split('.', 3).reduce((sum, part) => sum * 1000 + parseInt(part, 10), 0);

if (encode(process.versions.node) < encode(floor)) {
  process.stderr.write(
    `STIM_NODE_UNSUPPORTED: stim-server needs Node ${floor} or later; this is Node ${process.versions.node} at ${process.execPath}. To run stim-server where a project pins an older Node, see https://stim.appandflow.com/docs/requirements#older-node-pins\n`,
  );
  process.exitCode = 1;
} else {
  const { legacyMain } = await import('../../stim-cli/src/commands/serve.ts');
  await legacyMain();
}
