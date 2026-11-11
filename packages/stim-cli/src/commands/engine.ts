import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { configDir } from '@stim-cli/core';
import { compareVersions, installKind } from '../../bin/route.mjs';
import { defineOp, type Op } from '../cli/define-op.ts';
import { processContext } from '../cli-operation.ts';
import { getExecutor } from '../exec.ts';
import { collectStore } from '../engine-store/gc.ts';
import { takeLock } from '../engine-store/locks.ts';
import { migrateHomes, promote, type Promotion } from '../engine-store/promote.ts';
import { newestBad } from '../engine-store/select.ts';
import { machineRoot, readSchema, SCHEMA } from '../engine-store/schema.ts';
import { engineRoot, readManifest, readRecords } from '../engine-store/store.ts';
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

const status = defineOp({
  name: 'status',
  description: 'Show the engine, its previous and staged builds, and the state schemas',
  options: { json: { flags: '--json', description: 'print JSON' } },
  run({ options: opts }) {
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
    else if (current.pinReason) console.log(`${current.pinReason}; updates resume at the next newer build`);
    console.log(
      `previous ${previous ?? 'none'}, staged ${staged?.version ?? 'none'}, schema ${JSON.stringify(schemas)}`,
    );
  },
});

const install = defineOp({
  name: 'install',
  description: 'Make this copy of stim the machine engine',
  async run({ version }) {
    const root = engineRoot(process.env);
    if (readRecords(root).current)
      refuse(
        'STIM_ENGINE_REFUSED',
        `An engine is installed at ${root}.`,
        'Run stim engine use <version> or stim engine update.',
      );
    const self = dirname(dirname(spawnEntry('engine-select')));
    const kind = installKind(realpathSync(self), existsSync(root) ? realpathSync(root) : root);
    if (kind === 'development')
      refuse('STIM_ENGINE_REFUSED', `${self} runs in place.`, 'Run stim engine install from an installed stim.');
    const by = process.env.STIM_DESKTOP_APP ? 'desktop' : kind;
    await run(`install:${by}`, kind === 'npx' || kind === 'project' ? { version } : { dir: self });
    migrateHomes(engineRoot(process.env), [configDir(), machineRoot()], version);
  },
});

const use = defineOp({
  name: 'use',
  description: 'Run a version or a built checkout as the engine, pinned until stim engine update',
  arguments: '[target]',
  argumentDescriptions: { target: 'a stim version or the path of a built stim package' },
  options: { channel: { flags: '--channel <channel>', description: 'follow latest or next' } },
  async run({ args: [target], options: opts }) {
    const channel = opts.channel === 'latest' || opts.channel === 'next' ? opts.channel : undefined;
    if (opts.channel && !channel)
      refuse('STIM_BAD_ARG', `--channel ${opts.channel} is unknown.`, 'Use latest or next.');
    const { current } = readRecords(engineRoot(process.env));
    if (!current) missing();
    const source = target && /^\d+\.\d+\.\d+/.test(target) ? { version: target } : { dir: resolve(target ?? '') };
    const pinReason = target ? `set by stim engine use ${target}` : (current?.pinReason ?? null);
    await run('use', target ? source : { dir: join(engineRoot(process.env), current?.dir ?? '') }, {
      channel,
      pinReason,
      pinned: target ? true : current?.pinned,
    });
  },
});

const update = defineOp({
  name: 'update',
  description: 'Move the engine to the newest version on its channel and resume updates',
  async run() {
    const root = engineRoot(process.env);
    const { current, state } = readRecords(root);
    if (!current) return missing();
    const view = (await getExecutor().runFileAsync('npm', ['view', `stim@${current.channel}`, 'version'], NPM)).trim();
    const bad = newestBad(state.bad);
    if (bad && (compareVersions(view, bad) ?? 1) <= 0)
      refuse(
        'STIM_ENGINE_REFUSED',
        `The newest ${current.channel} release, ${view}, is at or below ${bad}, which crash-looped here.`,
        `Run stim engine use ${view} to run it anyway.`,
      );
    const have = state.installed.find((each) => each.version === view);
    await run('update', have ? { dir: join(root, have.dir) } : { version: view });
  },
});

const rollback = defineOp({
  name: 'rollback',
  description: 'Run the previous build as the engine, pinned until stim engine update',
  options: {
    restoreState: {
      flags: '--restore-state',
      description: 'put back the state snapshot taken before a newer build migrated the home',
    },
  },
  async run({ options: opts }) {
    const root = engineRoot(process.env);
    const { current, previous } = readRecords(root);
    const manifest = previous ? readManifest(join(root, previous)) : null;
    if (!current || !manifest)
      return refuse('STIM_ENGINE_REFUSED', `${root} has no previous build.`, 'Run stim engine use <version>.');
    await run(
      'rollback',
      { dir: join(root, manifest.build) },
      {
        pinReason: `rolled back from ${current.version}`,
        restoreState: opts.restoreState === true,
      },
    );
  },
});

const uninstall = defineOp({
  name: 'uninstall',
  description: 'Remove the engine; each copy of stim runs itself again',
  async run() {
    const root = engineRoot(process.env);
    if (!readRecords(root).current) return missing();
    const lock = (await takeLock(root, '.lock.sock')) ?? busy(root);
    try {
      for (const name of ['current.json', 'previous', 'staged.json', 'failed.json', 'state.json', 'bin', '.npm-cache'])
        rmSync(join(root, name), { recursive: true, force: true });
      collectStore(root);
      for (const name of ['state.json', '.trash']) rmSync(join(root, name), { recursive: true, force: true });
    } finally {
      await lock.release();
    }
    const kept = readdirSync(root);
    try {
      rmdirSync(root);
    } catch {}
    console.log(kept.length ? `Removed the engine pointer; ${root} keeps ${kept.join(', ')}.` : `Removed ${root}.`);
  },
});

const engine: Op = defineOp({
  name: 'engine',
  description: 'Manage the machine engine, the one Stim build every copy runs',
  commands: [status, install, use, update, rollback, uninstall],
});

export default engine;
