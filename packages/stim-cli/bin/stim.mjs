#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.STIM_ENGINE_ROOT || join(homedir(), '.stim', 'engine');
const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' ? null : undefined;
  }
};
let current = isAbsolute(root) ? read(join(root, 'current.json')) : null;

if (current === null) {
  await import('../dist/cli.mjs');
} else {
  const { installKind, route } = await import('./route.mjs');
  const self = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
  const copy = {
    version: JSON.parse(readFileSync(join(self, 'package.json'), 'utf8')).version,
    kind: installKind(self, realpathSync(root)),
  };
  const staged = read(join(root, 'staged.json'));
  const decision = route({
    args: process.argv,
    copy,
    current,
    staged: staged?.format === 1 ? staged : null,
    node: process.versions.node,
  });
  if (decision.promote) {
    const select = [join(self, 'dist', 'engine-select.mjs'), 'promote', '--set-by', `promote:${copy.kind}`];
    if (decision.promote === 'detached') spawn(process.execPath, select, { detached: true, stdio: 'ignore' }).unref();
    else if (spawnSync(process.execPath, select, { stdio: ['ignore', 'ignore', 'inherit'] }).status === 0)
      current = read(join(root, 'current.json')) ?? current;
  }
  if (decision.note) process.stderr.write(`${decision.note}\n`);
  const engine = (name) => join(root, current.dir, 'dist', name);
  let cli = null;
  if (decision.run === 'refuse') process.exitCode = 1;
  else if (decision.run === 'node') {
    process.exitCode =
      spawnSync(decision.node, [engine('cli.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1;
  } else if (decision.run === 'engine') {
    Reflect.set(globalThis, Symbol.for('stim.main'), true);
    try {
      cli = await import(pathToFileURL(engine('cli.mjs')).href);
    } catch (error) {
      Reflect.set(globalThis, Symbol.for('stim.main'), false);
      decision.fallback = true;
      process.stderr.write(
        `the engine ${current.version} cannot load (${error?.message}); this command runs this copy (${copy.version}). Run stim engine rollback or stim engine use <version> to repair it.\n`,
      );
    }
  }
  if (cli) {
    if (typeof cli.main === 'function') await cli.main(process.argv, { invokedVersion: copy.version });
  } else if (decision.run === 'own' || decision.fallback) {
    if (decision.fallback) process.env.STIM_ROUTER_FALLBACK = '1';
    await import('../dist/cli.mjs');
  }
}
