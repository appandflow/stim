import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StimContext } from '@stim-cli/core';
import { stimBuildId } from '@stim-cli/core/state';
import { installKind } from '../../bin/route.mjs';
import { getExecutor } from '../exec.ts';
import { claimsHeld, readBuildClaims } from './claims.ts';
import { collectStore } from './gc.ts';
import { takeLock } from './locks.ts';
import { machineRoot, migrateSchema, readSchema, restoreSchema, schemaRefusal } from './schema.ts';
import { promotionRefusal } from './select.ts';
import { BUILD_DIR, FORMAT, readManifest, readRecords, removeRecord, writeRecord, writeState } from './store.ts';
import type { Current, Manifest, Staged } from './store.ts';
import { cloneTree, fetchTree, scratchName, seal, selfTest } from './tree.ts';

export interface Promotion {
  root: string;
  /** A package directory to clone, a version to fetch from npm, or a directory of uploaded `.tgz` packages. */
  source: { dir: string } | { version: string } | { packages: string };
  setBy: string;
  /** A person's `stim engine` command: passes the pin, bad-build and newer-version checks. */
  explicit?: boolean;
  /** The reason the engine stays where this promotion puts it; omitted, none. */
  pinReason?: string | null;
  /**
   * Whether `pinReason` stops automatic sources until a person resumes them (a person's `use` or `rollback`), or only
   * holds the engine off the builds marked bad (a crash-loop rollback, false). Defaults to whether a reason is given.
   */
  pinned?: boolean;
  channel?: Current['channel'];
  /** `--restore-state`: puts back the claimed homes' snapshots for the target's schema just before the flip. */
  restoreState?: boolean;
  /** Set by a parent `engine-select` that holds the promotion lock for this process. */
  locked?: boolean;
  /**
   * Set by the stimd that saw every claim of the running build drained and holds both store locks: flips this build,
   * which must be the staged one, without reading any claim.
   */
  flip?: boolean;
  ctx: StimContext;
}

export type PromotionResult = { flipped: string } | { staged: string } | { refused: string } | { busy: true };

/**
 * Puts a build into the store and points the engine at it: under the promotion lock, gets the tree (cloned or
 * fetched), refuses unattended moves `promotionRefusal` names and builds the claimed homes' schema rules out, runs
 * the self-test, then flips at once with no live resident process or stages otherwise, and collects garbage. The
 * pointer is written by the build it names: another build's tree is handed to that tree's own `engine-select`.
 */
export async function promote(promotion: Promotion): Promise<PromotionResult> {
  const { root, source, ctx } = promotion;
  const lock = promotion.locked || promotion.flip ? { release: async () => {} } : await takeLock(root, '.lock.sock');
  if (!lock) return { busy: true };
  try {
    if (promotion.flip) return await flipStaged(promotion);
    let build = 'dir' in source && relative(realpathSync(root), realpathSync(source.dir)).match(BUILD_DIR)?.[0];
    if (!build) {
      const scratch = join(root, scratchName());
      const log = (line: string) => ctx.output('stderr', `${line}\n`);
      if ('version' in source) await fetchTree(root, { release: source.version }, scratch, log);
      else if ('packages' in source) await fetchTree(root, { from: source.packages }, scratch, log);
      else if (installKind(realpathSync(source.dir), realpathSync(root)) === 'development')
        await fetchTree(root, { pack: source.dir }, scratch, log);
      else await cloneTree(source.dir, scratch, ctx);
      build = seal(root, scratch);
    }
    const manifest = readManifest(join(root, build)) ?? fail(`${join(root, build)} has no store manifest.`);
    const refuse = (refused: string) => (collectStore(root), { refused });
    if (!existsSync(join(root, build, 'dist', 'engine-select.mjs')))
      return refuse(`stim ${manifest.version} predates the engine store; choose a later version`);
    const own = stimBuildId(dirname(fileURLToPath(import.meta.url)));
    if (own !== build) return await handOver(promotion, build);
    else {
      const { current, state } = readRecords(root);
      const homes = [ctx.home, machineRoot()].filter((home) => readSchema(home));
      const refusal =
        promotionRefusal(manifest, current, state.bad, promotion.explicit === true) ??
        (promotion.restoreState ? null : homes.map((home) => schemaRefusal(home, manifest.schema)).find(Boolean));
      if (refusal) return refuse(refusal);
      await selfTest(root, build).catch((error: unknown) => {
        collectStore(root);
        throw error;
      });
      const entry = { dir: build, version: manifest.version, installedAt: new Date().toISOString() };
      writeState(root, { ...state, installed: [...state.installed.filter((each) => each.dir !== build), entry] });
      if (claimsHeld(readBuildClaims(root))) {
        const staged: Staged = {
          format: FORMAT,
          dir: build,
          version: manifest.version,
          stagedAt: entry.installedAt,
          setBy: promotion.setBy,
          pinReason: promotion.pinReason ?? null,
          ...(promotion.pinned === false ? { pinned: false } : {}),
          ...(promotion.channel ? { channel: promotion.channel } : {}),
          ...(promotion.restoreState ? { restoreState: true } : {}),
        };
        writeRecord(join(root, 'staged.json'), staged);
        collectStore(root);
        return { staged: build };
      }
      for (const home of promotion.restoreState ? homes : []) restoreSchema(home, manifest.schema, manifest.version);
      await flip(root, build, manifest, current, promotion, false);
      for (const home of homes) migrateSchema(home, manifest.version);
      collectStore(root);
      return { flipped: build };
    }
  } finally {
    await lock.release();
  }
}

/** The drained running build's handover: points the engine at this build, staged with its pin, channel and setter. */
async function flipStaged(promotion: Promotion): Promise<PromotionResult> {
  const { root, ctx } = promotion;
  const { current, staged } = readRecords(root);
  const own = stimBuildId(dirname(fileURLToPath(import.meta.url)));
  if (!staged || staged.dir !== own) return { refused: `${own ?? 'this build'} is not the staged build` };
  const manifest = readManifest(join(root, own)) ?? fail(`${join(root, own)} has no store manifest.`);
  const homes = [ctx.home, machineRoot()].filter((home) => readSchema(home));
  if (staged.restoreState) for (const home of homes) restoreSchema(home, manifest.schema, manifest.version);
  else {
    const refusal = homes.map((home) => schemaRefusal(home, manifest.schema)).find(Boolean);
    if (refusal) {
      removeRecord(join(root, 'staged.json'));
      return { refused: refusal };
    }
  }
  const from = {
    ...promotion,
    setBy: staged.setBy ?? promotion.setBy,
    pinReason: staged.pinReason ?? null,
    pinned: staged.pinned,
  };
  await flip(root, own, manifest, current, { ...from, channel: staged.channel ?? promotion.channel }, true);
  for (const home of homes) migrateSchema(home, manifest.version);
  collectStore(root);
  return { flipped: own };
}

/** Runs `build`'s own `engine-select` on its tree while this process keeps holding the promotion lock for it. */
async function handOver(promotion: Promotion, build: string): Promise<PromotionResult> {
  const { root, ctx } = promotion;
  const args = ['--source', join(root, build), '--set-by', promotion.setBy, '--locked'];
  if (promotion.explicit) args.push('--explicit');
  if (promotion.pinReason) args.push(promotion.pinned === false ? '--hold' : '--pin', promotion.pinReason);
  if (promotion.channel) args.push('--channel', promotion.channel);
  if (promotion.restoreState) args.push('--restore-state');
  const select = join(root, build, 'dist', 'engine-select.mjs');
  const env = { STIM_ENGINE_ROOT: root, STIM_HOME: ctx.home };
  return JSON.parse(await getExecutor().runFileAsync(process.execPath, [select, ...args], { timeoutMs: 600_000, env }));
}

async function flip(
  root: string,
  build: string,
  manifest: Manifest,
  current: Current | null,
  promotion: Promotion,
  flipLocked: boolean,
) {
  const node = { path: process.execPath, version: process.versions.node };
  const flipLock = flipLocked
    ? { release: async () => {} }
    : ((await takeLock(root, '.flip.sock')) ?? fail(`Another process holds ${join(root, '.flip.sock')}.`));
  try {
    if (current && current.dir !== build) writeRecord(join(root, 'previous'), current.dir);
    else if (!current) {
      const state = readRecords(root).state;
      writeState(root, { ...state, installedBy: promotion.setBy });
    }
    writeRecord(join(root, 'current.json'), {
      format: FORMAT,
      version: manifest.version,
      build,
      dir: build,
      engines: manifest.engines,
      node: [node, ...(current?.node ?? []).filter((each) => each.path !== node.path)],
      channel: promotion.channel ?? current?.channel ?? (manifest.version.includes('-') ? 'next' : 'latest'),
      pinned: promotion.pinned ?? Boolean(promotion.pinReason),
      pinReason: promotion.pinReason ?? null,
      setBy: promotion.setBy,
      setAt: new Date().toISOString(),
    } satisfies Current);
    removeRecord(join(root, 'staged.json'));
    removeRecord(join(root, 'failed.json'));
  } finally {
    await flipLock.release();
  }
  const router = join(root, build, 'bin', 'stim.mjs');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeRecord(join(root, 'bin', 'stim'), `#!/bin/sh\nexec "${node.path}" "${router}" "$@"`, 0o755);
  writeRecord(join(root, 'bin', 'stim.cmd'), `@"${node.path}" "${router}" %*\r`);
  writeRecord(
    join(root, 'bin', 'stimd'),
    `#!/bin/sh\nexec "${node.path}" "${join(root, build, 'dist', 'cli.mjs')}" __stimd "$@"`,
    0o755,
  );
}

function fail(message: string): never {
  throw new Error(message);
}
