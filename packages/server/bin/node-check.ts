#!/usr/bin/env node
declare const NODE_FLOOR: string;

const encode = (version: string): number =>
  version.split('.', 3).reduce((sum, part) => sum * 1000 + parseInt(part, 10), 0);

if (encode(process.versions.node) < encode(NODE_FLOOR)) {
  process.stderr.write(
    `STIM_NODE_UNSUPPORTED: stim-server needs Node ${NODE_FLOOR} or later; this is Node ${process.versions.node} at ${process.execPath}. To run stim-server where a project pins an older Node, see https://stim.appandflow.com/docs/requirements#projects-that-pin-an-older-node\n`,
  );
  process.exitCode = 1;
} else {
  import('./stim-server.ts');
}
