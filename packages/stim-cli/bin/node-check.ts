#!/usr/bin/env node
import type { MainContext } from './cli.ts';

declare const NODE_FLOOR: string;

const encode = (version: string): number =>
  version.split('.', 3).reduce((sum, part) => sum * 1000 + parseInt(part, 10), 0);

/**
 * Runs the CLI for `argv` after checking the Node floor. A router that imports this module sets
 * `globalThis[Symbol.for('stim.main')]` first and calls `main` itself; a bare import or run executes the CLI.
 */
export async function main(argv: string[], ctx: MainContext = {}): Promise<void> {
  if (encode(process.versions.node) < encode(NODE_FLOOR)) {
    process.stderr.write(
      `STIM_NODE_UNSUPPORTED: Stim needs Node ${NODE_FLOOR} or later; this is Node ${process.versions.node} at ${process.execPath}. To run Stim where a project pins an older Node, see https://stim.appandflow.com/docs/requirements#older-node-pins\n`,
    );
    process.exitCode = 1;
    return;
  }
  Reflect.set(globalThis, Symbol.for('stim.main'), true);
  await (await import('./cli.ts')).main(argv, ctx);
}

if (!Reflect.get(globalThis, Symbol.for('stim.main'))) await main(process.argv);
