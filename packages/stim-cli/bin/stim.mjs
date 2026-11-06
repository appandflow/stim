#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.STIM_ENGINE_ROOT || join(homedir(), '.stim', 'engine');
const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return error instanceof SyntaxError ? undefined : null;
  }
};
let current = isAbsolute(root) ? read(join(root, 'current.json')) : null;
const entry = (dist) =>
  process.argv[2] === 'status' && existsSync(join(dist, 'status.mjs')) ? 'status.mjs' : 'cli.mjs';

if (current === null) {
  import(`../dist/${entry(fileURLToPath(new URL('../dist', import.meta.url)))}`);
} else {
  const { installKind, route } = await import('./route.mjs');
  const self = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
  const copy = {
    version: JSON.parse(readFileSync(join(self, 'package.json'), 'utf8')).version,
    kind: installKind(self, realpathSync(root)),
  };
  const staged = read(join(root, 'staged.json'));
  const failed = read(join(root, 'failed.json'));
  const decide = () =>
    route({
      args: process.argv,
      copy,
      current,
      staged: staged?.format === 1 ? staged : null,
      node: process.versions.node,
      failed: failed?.format === 1 ? failed : null,
      now: Date.now(),
    });
  let decision = decide();
  if (decision.promote) {
    const select = [join(self, 'dist', 'engine-select.mjs'), 'promote', '--set-by', `promote:${copy.kind}`];
    if (decision.promote === 'detached') spawn(process.execPath, select, { detached: true, stdio: 'ignore' }).unref();
    else if (spawnSync(process.execPath, select, { stdio: ['ignore', 'ignore', 'inherit'] }).status === 0) {
      current = read(join(root, 'current.json')) ?? current;
      decision = { ...decide(), promote: undefined };
    }
  }
  if (decision.note) process.stderr.write(`${decision.note}\n`);
  const engine = (name) => join(root, current.dir, 'dist', name);
  const runOwn = (error) => {
    process.stderr.write(
      `the engine ${current.version} cannot load (${error?.message}); this command runs this copy (${copy.version}). Run stim engine rollback or stim engine use <version> to repair it.\n`,
    );
    Reflect.set(globalThis, Symbol.for('stim.main'), false);
    process.env.STIM_ROUTER_FALLBACK = '1';
    return import('../dist/cli.mjs');
  };
  if (decision.run === 'refuse') process.exitCode = 1;
  else if (decision.run === 'node') {
    const run = spawnSync(decision.node, [engine('cli.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
    if (run.error) runOwn(run.error);
    else process.exitCode = run.status ?? 1;
  } else if (decision.run === 'engine') {
    Reflect.set(globalThis, Symbol.for('stim.main'), true);
    import(pathToFileURL(engine(entry(join(root, current.dir, 'dist')))).href).then(
      (cli) => cli.main?.(process.argv, { invokedVersion: copy.version, onLoadError: runOwn }),
      runOwn,
    );
  } else {
    if (decision.fallback) process.env.STIM_ROUTER_FALLBACK = '1';
    import('../dist/cli.mjs');
  }
}
