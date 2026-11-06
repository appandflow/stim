import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StimContext } from '@stim-cli/core';
import { stimBuildId } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { collectStore, liveEngineDirs } from './gc.ts';
import { takeLock } from './locks.ts';
import { machineRoot, migrateSchema, readSchema, schemaRefusal } from './schema.ts';
import { promotionRefusal } from './select.ts';
import { BUILD_DIR, readManifest, readRecords, removeRecord, writeRecord, writeState, type Current } from './store.ts';
import { cloneTree, fetchTree, scratchName, seal, selfTest } from './tree.ts';

export interface Promotion {
  root: string;
  /** A package directory to clone, or a version to fetch from npm. */
  source: { dir: string } | { version: string };
  setBy: string;
  /** A person's `stim engine` command: passes the pin, bad-build and newer-version checks. */
  explicit?: boolean;
  /** Pins the engine with this reason; omitted, the engine is unpinned. */
  pinReason?: string | null;
  channel?: Current['channel'];
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
  const lock = await takeLock(root, '.lock.sock');
  if (!lock) return { busy: true };
  let handover: string | null = null;
  try {
    let build = 'dir' in source && relative(realpathSync(root), realpathSync(source.dir)).match(BUILD_DIR)?.[0];
    if (!build) {
      const scratch = join(root, scratchName());
      if ('dir' in source) await cloneTree(source.dir, scratch, ctx);
      else await fetchTree(root, source.version, scratch, (line) => ctx.output('stderr', `${line}\n`));
      build = seal(root, scratch);
    }
    const manifest = readManifest(join(root, build));
    if (!manifest) throw new Error(`${join(root, build)} has no store manifest.`);
    if (!existsSync(join(root, build, 'dist', 'engine-select.mjs')))
      return { refused: `stim ${manifest.version} predates the engine store; choose a later version` };
    const own = stimBuildId(dirname(fileURLToPath(import.meta.url)));
    if (own !== build) handover = build;
    else {
      const { current, state } = readRecords(root);
      const refusal =
        promotionRefusal(manifest, current, state.bad, promotion.explicit === true) ??
        schemaRefusal(ctx.home, manifest.schema) ??
        schemaRefusal(machineRoot(), manifest.schema);
      if (refusal) return { refused: refusal };
      await selfTest(root, build);
      state.installed = [
        ...state.installed.filter((each) => each.dir !== build),
        { dir: build, version: manifest.version, installedAt: new Date().toISOString() },
      ];
      writeState(root, state);
      const claimed = liveEngineDirs();
      if (claimed.length > 0) {
        writeRecord(join(root, 'staged.json'), {
          format: 1,
          dir: build,
          version: manifest.version,
          stagedAt: new Date().toISOString(),
        });
        return { staged: build };
      }
      await flip(root, build, manifest, current, promotion);
      for (const home of [ctx.home, machineRoot()]) if (readSchema(home)) migrateSchema(home, manifest.version);
      collectStore(root, claimed);
      return { flipped: build };
    }
  } finally {
    await lock.release();
  }
  const args = ['promote', '--source', join(root, handover), '--set-by', promotion.setBy];
  if (promotion.explicit) args.push('--explicit');
  if (promotion.pinReason) args.push('--pin', promotion.pinReason);
  if (promotion.channel) args.push('--channel', promotion.channel);
  const output = await getExecutor().runFileAsync(
    process.execPath,
    [join(root, handover, 'dist', 'engine-select.mjs'), ...args],
    {
      timeoutMs: 10 * 60_000,
      env: { STIM_ENGINE_ROOT: root, STIM_HOME: ctx.home },
    },
  );
  return JSON.parse(output);
}

async function flip(
  root: string,
  build: string,
  manifest: { version: string; engines: string },
  current: Current | null,
  promotion: Promotion,
): Promise<void> {
  const node = { path: process.execPath, version: process.versions.node };
  const next: Current = {
    format: 1,
    version: manifest.version,
    build,
    dir: build,
    node: [node, ...(current?.node ?? []).filter((each) => each.path !== node.path)],
    engines: manifest.engines,
    channel: promotion.channel ?? current?.channel ?? (manifest.version.includes('-') ? 'next' : 'latest'),
    pinned: Boolean(promotion.pinReason),
    pinReason: promotion.pinReason ?? null,
    setBy: promotion.setBy,
    setAt: new Date().toISOString(),
  };
  const flipLock = await takeLock(root, '.flip.sock');
  if (!flipLock) throw new Error(`Another process holds ${join(root, '.flip.sock')}.`);
  try {
    if (current && current.dir !== build) writeRecord(join(root, 'previous'), current.dir);
    writeRecord(join(root, 'current.json'), next);
    removeRecord(join(root, 'staged.json'));
  } finally {
    await flipLock.release();
  }
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const router = join(root, build, 'bin', 'stim.mjs');
  writeRecord(join(bin, 'stim'), `#!/bin/sh\nexec "${node.path}" "${router}" "$@"`);
  chmodSync(join(bin, 'stim'), 0o755);
  writeRecord(join(bin, 'stim.cmd'), `@"${node.path}" "${router}" %*\r`);
}
