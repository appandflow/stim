import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { configDir } from '@stim-cli/core';
import { installKind } from '../../bin/route.mjs';
import { processContext } from '../cli-operation.ts';
import { getExecutor } from '../exec.ts';
import { collectStore } from '../engine-store/gc.ts';
import { takeLock } from '../engine-store/locks.ts';
import { promote, type Promotion } from '../engine-store/promote.ts';
import { engineRoot } from '../engine-store/root.ts';
import { machineRoot, migrateSchema, readSchema, restoreSchema, SCHEMA } from '../engine-store/schema.ts';
import { BUILD_DIR, readManifest, readRecords } from '../engine-store/store.ts';
import { spawnEntry } from '../spawn-entry.ts';

function refuse(code: string, message: string, remedy: string): never {
  throw Object.assign(new Error(`${message}\n${remedy}`), { code, remedy });
}

async function run(promotion: Omit<Promotion, 'root' | 'ctx' | 'setBy'>, setBy: string): Promise<void> {
  const root = engineRoot(process.env);
  const result = await promote({ ...promotion, root, setBy, ctx: processContext(process.cwd()) });
  if ('busy' in result)
    refuse(
      'STIM_ENGINE_BUSY',
      `Another process is changing the engine at ${root}.`,
      'Run the command again when it ends.',
    );
  if ('refused' in result) refuse('STIM_ENGINE_REFUSED', result.refused, 'Nothing changed.');
  const { current } = readRecords(root);
  if ('staged' in result) console.log(`stim ${current?.version} keeps running; ${result.staged} is staged.`);
  else console.log(`The engine at ${root} runs stim ${current?.version} (${current?.build}).`);
}

export default function engineCommand(program: Command, version: string): void {
  const engine = program.command('engine').description('Manage the machine engine, the one Stim build every copy runs');
  engine
    .command('status')
    .description('Show the engine, its previous and staged builds, and the state schemas')
    .option('--json', 'print JSON')
    .action((opts) => {
      const root = engineRoot(process.env);
      const { current, previous, staged, state } = readRecords(root);
      const schemas = {
        build: SCHEMA,
        home: readSchema(configDir())?.schema ?? null,
        machine: readSchema(machineRoot())?.schema ?? null,
      };
      if (opts.json)
        return console.log(
          JSON.stringify({ root, current, previous, staged, installed: state.installed, bad: state.bad, schemas }),
        );
      if (!current)
        return console.log(
          `No engine is installed at ${root}; each copy of stim runs itself. Run stim engine install to install one.`,
        );
      console.log(
        `engine    stim ${current.version} (${current.build}), channel ${current.channel}, set by ${current.setBy} at ${current.setAt}`,
      );
      if (current.pinned) console.log(`pinned    ${current.pinReason}; run stim engine update to resume updates`);
      if (previous) console.log(`previous  ${previous}`);
      if (staged) console.log(`staged    stim ${staged.version} (${staged.dir})`);
      console.log(
        `schema    build ${schemas.build}, home ${schemas.home ?? 'unset'}, machine ${schemas.machine ?? 'unset'}`,
      );
    });
  engine
    .command('install')
    .description('Make this copy of stim the machine engine')
    .action(async () => {
      const self = dirname(dirname(spawnEntry('engine-select')));
      const kind = installKind(self, engineRoot(process.env));
      if (kind === 'development')
        refuse(
          'STIM_ENGINE_DEVELOPMENT',
          `${self} is a development tree, which runs in place.`,
          `Run stim engine use ${self} to put its build in the store.`,
        );
      await run(
        { source: kind === 'npx' || kind === 'project' ? { version } : { dir: self }, explicit: true },
        'install',
      );
      for (const root of [configDir(), machineRoot()]) migrateSchema(root, version);
    });
  engine
    .command('use')
    .description('Run a given version or built checkout as the engine, pinned until stim engine update')
    .argument('[target]', 'a stim version or the path of a built stim package')
    .option('--channel <channel>', 'follow latest or next')
    .action(async (target: string | undefined, opts: { channel?: string }) => {
      const channel = opts.channel === 'latest' || opts.channel === 'next' ? opts.channel : undefined;
      if (opts.channel && !channel)
        refuse(
          'STIM_BAD_ARG',
          `--channel must be latest or next, got ${opts.channel}.`,
          'Pass --channel latest or --channel next.',
        );
      const { current } = readRecords(engineRoot(process.env));
      if (!target && !current)
        refuse('STIM_ENGINE_MISSING', 'No engine is installed.', 'Run stim engine install first.');
      const source = !target
        ? { dir: join(engineRoot(process.env), current?.dir ?? '') }
        : /^\d+\.\d+\.\d+/.test(target)
          ? { version: target }
          : { dir: resolve(target) };
      await run(
        {
          source,
          explicit: true,
          channel,
          pinReason: target ? `set by stim engine use ${target}` : (current?.pinReason ?? null),
        },
        'use',
      );
    });
  engine
    .command('update')
    .description('Move the engine to the newest version on its channel and resume updates')
    .action(async () => {
      const root = engineRoot(process.env);
      const { current, state } = readRecords(root);
      if (!current) refuse('STIM_ENGINE_MISSING', 'No engine is installed.', 'Run stim engine install first.');
      const tag = current.channel;
      const newest = (
        await getExecutor().runFileAsync('npm', ['view', `stim@${tag}`, 'version'], { timeoutMs: 60_000 })
      ).trim();
      const installed = state.installed.find((each) => each.version === newest);
      await run(
        { source: installed ? { dir: join(root, installed.dir) } : { version: newest }, explicit: true },
        'update',
      );
    });
  engine
    .command('rollback')
    .description('Run the previous build as the engine, pinned until stim engine update')
    .option('--restore-state', 'put back the home state snapshot taken before a newer build migrated it')
    .action(async (opts: { restoreState?: boolean }) => {
      const root = engineRoot(process.env);
      const { current, previous } = readRecords(root);
      const manifest = previous ? readManifest(join(root, previous)) : null;
      if (!current || !manifest)
        refuse(
          'STIM_ENGINE_NO_PREVIOUS',
          `The engine at ${root} has no previous build.`,
          'Run stim engine use <version> to choose one.',
        );
      if (opts.restoreState)
        for (const home of [configDir(), machineRoot()])
          if (readSchema(home)) restoreSchema(home, manifest.schema, manifest.version);
      await run(
        {
          source: { dir: join(root, manifest.build) },
          explicit: true,
          pinReason: `rolled back from ${current.version}`,
        },
        'rollback',
      );
    });
  engine
    .command('uninstall')
    .description('Remove the engine; each copy of stim runs itself again')
    .action(async () => {
      const root = engineRoot(process.env);
      const lock = await takeLock(root, '.lock.sock');
      if (!lock)
        refuse(
          'STIM_ENGINE_BUSY',
          `Another process is changing the engine at ${root}.`,
          'Run the command again when it ends.',
        );
      try {
        for (const name of ['current.json', 'previous', 'staged.json', 'bin', '.npm-cache'])
          rmSync(join(root, name), { recursive: true, force: true });
        collectStore(root);
      } finally {
        await lock.release();
      }
      const kept = readdirSync(root).filter((name) => BUILD_DIR.test(name));
      if (kept.length === 0) rmSync(root, { recursive: true, force: true });
      console.log(
        kept.length
          ? `Removed the engine pointer; ${kept.join(', ')} stay while processes run from them.`
          : `Removed the engine at ${root}.`,
      );
    });
}
