#!/usr/bin/env node
declare const NODE_FLOOR: string;

const encode = (version: string): number => version.split('.').reduce((sum, part) => sum * 1000 + Number(part), 0);

if (encode(process.versions.node) < encode(NODE_FLOOR)) {
  process.stderr.write(
    `STIM_NODE_UNSUPPORTED: Stim needs Node ${NODE_FLOOR} or later; this is Node ${process.versions.node} at ${process.execPath}. To run Stim where a project pins an older Node, see https://stim.appandflow.com/docs/requirements#older-node-pins\n`,
  );
  process.exitCode = 1;
} else {
  import('./cli.ts');
}
