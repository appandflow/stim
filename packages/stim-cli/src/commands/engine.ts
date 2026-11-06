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
import { machineRoot, migrateSchema, readSchema, restoreSchema, SCHEMA } from '../engine-store/schema.ts';
import { BUILD_DIR, engineRoot, readManifest, readRecords } from '../engine-store/store.ts';
import { spawnEntry } from '../spawn-entry.ts';

function refuse(code: string, message: string, remedy: string): never {
  throw Object.assign(new Error(`${message} ${remedy}`), { code, remedy });
}

const busy = (root: string) => refuse('STIM_ENGINE_BUSY', `Another process is changing ${root}.`, 'Run it again.');
const NPM = { timeoutMs: 60_000 };
const missing = () => refuse('STIM_ENGINE_REFUSED', 'No engine is installed.', 'Run stim engine install first.');

async function run(setBy: string, source: Promotion['source'], more: Partial<Promotion> = {}): Promise<void> {
  const root = engineRoot(process.env);
  const result = await promote({ root, source, setBy, explicit: true, ctx: processContext(process.cwd()), ...more });
  if ('busy' in result) busy(root);
  if ('refused' in result) refuse('STIM_ENGINE_REFUSED', result.refused, 'Nothing changed.');
  const { current } = readRecords(root);
  console.log(
    `The engine at ${root} runs stim ${current?.version}${'staged' in result ? `; ${result.staged} is staged` : ''}.`,
  );
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
        home: readSchema(configDir())?.schema,
        machine: readSchema(machineRoot())?.schema,
      };
      const report = { root, current, previous, staged, installed: state.installed, bad: state.bad, schemas };
      if (opts.json) return console.log(JSON.stringify(report));
      if (!current) return console.log(`No engine is installed at ${root}; run stim engine install to install one.`);
      console.log(`stim ${current.version} (${current.build}) on ${current.channel}, set by ${current.setBy}`);
      if (current.pinned) console.log(`pinned: ${current.pinReason}; run stim engine update to resume updates`);
      console.log(
        `previous ${previous ?? 'none'}, staged ${staged?.version ?? 'none'}, schema ${JSON.stringify(schemas)}`,
      );
    });
  engine
    .command('install')
    .description('Make this copy of stim the machine engine')
    .action(async () => {
      const self = dirname(dirname(spawnEntry('engine-select')));
      const kind = installKind(self, engineRoot(process.env));
      if (kind === 'development')
        refuse('STIM_ENGINE_REFUSED', `${self} runs in place.`, `Run stim engine use ${self}.`);
      await run('install', kind === 'npx' || kind === 'project' ? { version } : { dir: self });
      for (const root of [configDir(), machineRoot()]) migrateSchema(root, version);
    });
  engine
    .command('use')
    .description('Run a version or a built checkout as the engine, pinned until stim engine update')
    .argument('[target]', 'a stim version or the path of a built stim package')
    .option('--channel <channel>', 'follow latest or next')
    .action(async (target: string | undefined, opts: { channel?: string }) => {
      const channel = opts.channel === 'latest' || opts.channel === 'next' ? opts.channel : undefined;
      if (opts.channel && !channel)
        refuse('STIM_BAD_ARG', `--channel ${opts.channel} is unknown.`, 'Use latest or next.');
      const { current } = readRecords(engineRoot(process.env));
      if (!target && !current) missing();
      const source = target && /^\d+\.\d+\.\d+/.test(target) ? { version: target } : { dir: resolve(target ?? '') };
      const pinReason = target ? `set by stim engine use ${target}` : (current?.pinReason ?? null);
      await run('use', target ? source : { dir: join(engineRoot(process.env), current?.dir ?? '') }, {
        channel,
        pinReason,
      });
    });
  engine
    .command('update')
    .description('Move the engine to the newest version on its channel and resume updates')
    .action(async () => {
      const root = engineRoot(process.env);
      const { current, state } = readRecords(root);
      if (!current) return missing();
      const view = await getExecutor().runFileAsync('npm', ['view', `stim@${current.channel}`, 'version'], NPM);
      const have = state.installed.find((each) => each.version === view.trim());
      await run('update', have ? { dir: join(root, have.dir) } : { version: view.trim() });
    });
  engine
    .command('rollback')
    .description('Run the previous build as the engine, pinned until stim engine update')
    .option('--restore-state', 'put back the state snapshot taken before a newer build migrated the home')
    .action(async (opts: { restoreState?: boolean }) => {
      const root = engineRoot(process.env);
      const { current, previous } = readRecords(root);
      const manifest = previous ? readManifest(join(root, previous)) : null;
      if (!current || !manifest)
        return refuse('STIM_ENGINE_REFUSED', `${root} has no previous build.`, 'Run stim engine use <version>.');
      for (const home of opts.restoreState ? [configDir(), machineRoot()] : [])
        if (readSchema(home)) restoreSchema(home, manifest.schema, manifest.version);
      await run('rollback', { dir: join(root, manifest.build) }, { pinReason: `rolled back from ${current.version}` });
    });
  engine
    .command('uninstall')
    .description('Remove the engine; each copy of stim runs itself again')
    .action(async () => {
      const root = engineRoot(process.env);
      const lock = (await takeLock(root, '.lock.sock')) ?? busy(root);
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
        kept.length ? `Removed the engine; ${kept.join(', ')} stay while processes run from them.` : `Removed ${root}.`,
      );
    });
}
