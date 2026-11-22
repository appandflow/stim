import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { GcMark } from '@stim-cli/core/state';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { realpathAsync } from '../commands/gc/paths.ts';
import { trustedMeasure } from '../disk-usage.ts';
import { formatBytes } from '../fs-util.ts';
import { maintenancePinnedReader } from '../stimd/passes/protect.ts';
import { answered } from '../workspace/bounded-read.ts';
import type { Config } from '../workspace/config.ts';
import { regenerableDirProblem } from '../workspace/regenerable-dirs.ts';
import { warmCopyingFrom, warmedFromAt } from '../workspace/source-dependencies.ts';
import { resolveSourceCheckoutAsync } from '../workspace/worktree.ts';
import { readRunningProcessesAsync, runningFromReason } from '../workspace/running-from.ts';
import { rankedPrivateBytes, selectDependencies, type RankedDependency } from './dependencies.ts';
import { dependencyMarkDue } from './dependency-marks.ts';
import { outputMarks } from './marks.ts';
import { dormantAfterMs, runsSomething, stillIdle, type DeviceReading } from './stages.ts';

export interface DependencyReport {
  rung: 5 | 8;
  target: string;
  workspace?: string;
  detail: string;
}

/** Reports saved dependency inventory using targeted current safety reads, without discovering or measuring trees. */
export async function savedDependencyReports(
  config: Config,
  options: DeviceReading & {
    level: 'high' | 'critical';
    onVolume: (path: string, source: boolean) => boolean;
  },
): Promise<DependencyReport[]> {
  const { operation } = options;
  const reports: DependencyReport[] = [];
  const eligible: { rung: 5 | 8; dependency: RankedDependency }[] = [];
  let processes: ReturnType<typeof readRunningProcessesAsync> | undefined;
  const identities = new Map<string, Promise<string>>();
  const native = (path: string) => {
    let value = identities.get(path);
    if (!value) {
      value = answered(path, () => realpath(path), 3_000, operation?.signal);
      identities.set(path, value);
    }
    return value;
  };
  const marks = await outputMarks(config, operation);
  const covered = new Set(marks.flatMap((mark) => [mark.root, ...(mark.dependencies?.keys ?? [])]));
  for (const root of Object.keys(config.projects))
    if (!covered.has(root) && options.onVolume(root, false))
      reports.push({
        rung: 5,
        target: root,
        detail: 'dependency inventory is unknown; the normal lane has not observed it',
      });
  for (const mark of marks) {
    operation?.signal.throwIfAborted();
    const observation = mark.dependencies;
    if (!observation) {
      if (options.onVolume(mark.root, false))
        reports.push({
          rung: 5,
          target: mark.root,
          detail: 'dependency inventory is unknown; its normal producer may be disabled',
        });
      continue;
    }
    const source = observation.role === 'source';
    if (source && options.level !== 'critical') continue;
    const rung = source ? 8 : 5;
    const idleMs = options.level === 'critical' ? 2 * 60_000 : 60 * 60_000;
    let keep: string | null = null;
    try {
      const root = await native(mark.root);
      if (
        (await answered(mark.root, () => realpathAsync(mark.root), 3_000, operation?.signal)) !== mark.root ||
        (await answered(mark.root, () => stat(mark.root), 3_000, operation?.signal)).dev !== mark.device
      )
        keep = 'the marked checkout moved or changed volume';
      if (
        !keep &&
        (Date.parse(mark.dirtyAt ?? '') > Date.parse(observation.markedAt) ||
          dependencyMarkDue(mark, Date.now(), dormantAfterMs(config, operation?.env)))
      )
        keep = 'the saved dependency observation is due or dirty; current eligibility is unknown';
      if (!observation.candidates.length) {
        if (keep && options.onVolume(mark.root, source)) reports.push({ rung, target: mark.root, detail: keep });
        continue;
      }
      const currentKeys: string[] = [mark.root];
      for (const key of Object.keys(config.projects)) {
        try {
          const path = await native(key);
          if ((path === root || path.startsWith(`${root}${sep}`)) && !currentKeys.includes(key)) currentKeys.push(key);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')))
            throw error;
        }
      }
      if (
        !keep &&
        (currentKeys.length !== observation.keys.length || currentKeys.some((key) => !observation.keys.includes(key)))
      )
        keep = 'the checkout workspace membership changed since the dependency observation';
      if (!keep && options.protectedRoot) {
        const protectedPath = await native(options.protectedRoot);
        if (protectedPath === root || protectedPath.startsWith(`${root}${sep}`))
          keep = 'the command runs inside this checkout';
      }
      if (!keep)
        keep = await checkoutKeep(mark, currentKeys, source, idleMs, native, {
          config,
          reading: options,
          processes: () => (processes ??= readRunningProcessesAsync(operation?.signal)),
        });

      for (const candidate of observation.candidates) {
        if (!options.onVolume(candidate.path, source)) continue;
        let reason = keep;
        let identityKnown = false;
        try {
          const base = candidate.path.endsWith(`${sep}ios${sep}Pods`)
            ? dirname(dirname(candidate.path))
            : dirname(candidate.path);
          const bases = new Set(await Promise.all([mark.root, ...currentKeys].map(native)));
          if (
            ![join(base, 'node_modules'), join(base, 'ios', 'Pods')].includes(candidate.path) ||
            !bases.has(await native(base))
          )
            reason = 'the saved dependency path is outside its current holder';
          else {
            const info = await answered(candidate.path, () => lstat(candidate.path), 3_000, operation?.signal);
            identityKnown =
              info.isDirectory() &&
              !info.isSymbolicLink() &&
              info.dev === candidate.device &&
              (await answered(candidate.path, () => realpathAsync(candidate.path), 3_000, operation?.signal)) ===
                candidate.path;
            if (!identityKnown) reason = 'the saved dependency path moved or changed volume';
          }
          if (!reason) reason = await regenerableDirProblem(mark.root, candidate.path, operation?.signal);
        } catch (error) {
          if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
          operation?.signal.throwIfAborted();
          reason = 'the dependency path could not be checked; current eligibility is unknown';
        }
        const privateBytes = identityKnown ? rankedPrivateBytes(candidate.path) : null;
        if (reason || candidate.keep) {
          reports.push({
            rung,
            target: candidate.path,
            workspace: observation.keys[0],
            detail: `${reason ?? candidate.keep?.reason}; report only: cached private bytes ${privateBytes === null ? 'unknown' : formatBytes(privateBytes)}`,
          });
          continue;
        }
        eligible.push({
          rung,
          dependency: {
            candidate: {
              worktree: mark.root,
              path: candidate.path,
              keys: currentKeys,
              locked: false,
              reduceOnly: false,
              source,
            },
            source,
            workspace: observation.keys[0] ?? mark.root,
            bytes: trustedMeasure(candidate.path)?.bytes ?? null,
            privateBytes,
          },
        });
      }
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
      if (!observation.candidates.length && options.onVolume(mark.root, source))
        reports.push({
          rung,
          target: mark.root,
          detail: 'current dependency eligibility could not be checked; it stays',
        });
      for (const candidate of observation.candidates)
        if (options.onVolume(candidate.path, source))
          reports.push({
            rung,
            target: candidate.path,
            detail: 'current dependency eligibility could not be checked; it stays',
          });
    }
  }
  for (const rung of [5, 8] as const) {
    const { take, kept } = selectDependencies(
      eligible.filter((entry) => entry.rung === rung).map((entry) => entry.dependency),
      'take',
    );
    for (const { dependency, detail } of kept)
      reports.push({ rung, target: dependency.candidate.path, workspace: dependency.workspace, detail });
    for (const dependency of take)
      reports.push({
        rung,
        target: dependency.candidate.path,
        workspace: dependency.workspace,
        detail: `report only: deleting it would free ${dependency.privateBytes === null ? 'an unknown amount' : formatBytes(dependency.privateBytes)}`,
      });
  }
  return reports;
}

async function checkoutKeep(
  mark: GcMark,
  keys: string[],
  source: boolean,
  idleMs: number,
  native: (path: string) => Promise<string>,
  context: { config: Config; reading: DeviceReading; processes: () => ReturnType<typeof readRunningProcessesAsync> },
): Promise<string | null> {
  const { config, reading } = context;
  const { operation } = reading;
  for (const key of keys)
    if (await runsSomething(key, config.projects[key] ?? {}, reading)) return 'something of it runs';
  const running = runningFromReason(mark.root, await context.processes());
  if (running) return running;
  const metadata = await resolveSourceCheckoutAsync(mark.root, {
    cache: false,
    timeoutMs: 3_000,
    signal: operation?.signal,
    env: operation?.env,
    declareFor: operation,
  });
  if ('refusal' in metadata) return metadata.refusal;
  const root = await native(mark.root);
  const entry = metadata.entries.find((listed) => listed.path === root);
  if (!entry || entry.locked || entry.prunable || entry.bare || source !== ((await native(metadata.path)) === root))
    return 'the current Git role or lock differs from the dependency observation';
  const pinned = maintenancePinnedReader(operation);
  for (const key of new Set([mark.root, ...keys])) {
    if (await pinned(key)) return `${key} is pinned`;
    if (!(await stillIdle(key, idleMs, { operation, full: source, locked: false, checkout: mark.root })))
      return `${key} is no longer idle`;
  }
  if (source) {
    const warming = warmCopyingFrom(mark.root);
    if (warming) return warming;
    if (Date.now() - warmedFromAt(keys) < idleMs) return 'a worktree warm recently copied from it';
    // @ref LLP 0001#the-lane-marks-what-each-checkout-could-free -- pressure reports do not rediscover other worktrees' dependency links
    if (metadata.entries.length > 1)
      return 'current sharing with linked worktrees is unproven; dependency eligibility is unknown';
  }
  return null;
}
