import { stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import type { DaemonPressure, DaemonWorkspaceDecision } from '@stim-cli/core/state';
import { LOCKFILES } from '../cache/static-fingerprint.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { runFingerprintPrecompute, type FingerprintPrecomputeRequest } from '../fingerprint-precompute.ts';
import type { FingerprintPrecompute } from '../cache/fingerprint-memo.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { sizeScanDeferred } from '../stimd/passes/measure.ts';
import type { Config, ProjectRecord } from '../workspace/config.ts';
import { gitAsync } from '../workspace/git.ts';
import { resolveAndroidLayout, resolveIosProjectDir, resolveProjectSettingsAsync } from '../workspace/settings.ts';

export const MAX_PRECOMPUTES_PER_PASS = 2;

export interface PrecomputeInput {
  config: Config | null;
  workspaces: readonly DaemonWorkspaceDecision[];
  pressure: Pick<DaemonPressure, 'level'>;
  operation: StimContext;
}

export interface PrecomputeDependencies {
  signature: (root: string, signal: AbortSignal) => Promise<string>;
  requests: (path: string, project: ProjectRecord, operation: StimContext) => Promise<FingerprintPrecomputeRequest[]>;
  run: (operation: StimContext, request: FingerprintPrecomputeRequest) => Promise<FingerprintPrecompute>;
  loadDeferred: () => boolean;
}

type Log = (level: 'debug' | 'warn', event: string, msg: string, fields?: Record<string, unknown>) => void;

function precomputeHold({
  act,
  pressure,
  loadDeferred,
}: {
  act: boolean;
  pressure: Pick<DaemonPressure, 'level'>;
  loadDeferred: boolean;
}): string | null {
  if (!act) return 'daemon.mode is report';
  if (pressure.level !== 'normal') return `pressure level ${pressure.level}`;
  if (loadDeferred) return 'host load exceeds 4 per core';
  return null;
}

const present = async (path: string) => stat(path).catch(() => null);

const INSTALL_STAMPS = ['.modules.yaml', '.package-lock.json', '.yarn-integrity', '.yarn-state.yml'];

async function installSignature(dir: string): Promise<string> {
  const stamps = await Promise.all(
    INSTALL_STAMPS.map(async (name) => {
      const info = await present(join(dir, 'node_modules', name));
      return info ? `${name}:${info.mtimeMs}` : '';
    }),
  );
  return stamps.join(',');
}

async function lockfileSignature(root: string): Promise<string> {
  for (let dir = root; ; dir = dirname(dir)) {
    for (const name of LOCKFILES) {
      const info = await present(join(dir, name));
      if (info)
        return `${relative(root, join(dir, name))}:${info.size}:${info.mtimeMs}|${await installSignature(root)}|${await installSignature(dir)}`;
    }
    if ((await present(join(dir, '.git'))) || dirname(dir) === dir) return 'none';
  }
}

export async function treeSignature(root: string, signal: AbortSignal): Promise<string> {
  const head = await gitAsync(root, ['rev-parse', 'HEAD'], { signal }).catch((error: unknown) => {
    if (error instanceof Error && 'reportCleanup' in error) throw error;
    signal.throwIfAborted();
    return 'no-head';
  });
  return `${head}|${await lockfileSignature(root)}`;
}

async function precomputeRequests(
  path: string,
  project: ProjectRecord,
  operation: StimContext,
): Promise<FingerprintPrecomputeRequest[]> {
  const used = new Set<string>();
  for (const { platforms } of projectDeviceSlots(project)) {
    if (platforms.ios) used.add('ios');
    if (platforms.android) used.add('android');
  }
  if (!used.size) return [];
  const root = canonicalPath(path);
  const { context, settings } = await resolveProjectSettingsAsync(root, {
    env: operation.env,
    signal: operation.signal,
    declareFor: operation,
  });
  const requests: FingerprintPrecomputeRequest[] = [];
  const ios = used.has('ios') ? projectRegistry.selectIos(root) : null;
  if (ios && 'id' in ios && ios.id === 'react-native')
    requests.push({ root, platform: 'ios', iosProjectPath: resolveIosProjectDir(settings, root).relative });
  const android = used.has('android') ? projectRegistry.selectAndroid(root) : null;
  if (android && 'id' in android && android.id === 'react-native')
    requests.push({
      root,
      platform: 'android',
      androidLayout: resolveAndroidLayout(settings, root, context.repoRoot ?? root),
    });
  return requests;
}

/**
 * Records the full fingerprint of each live, non-idle workspace's tree ahead of the next `stim ios` or `stim android`
 * when its HEAD, lockfile or install stamp changed since the last pass, so that run finds it in the fingerprint memo instead of
 * computing it. Each fingerprint runs in a low-priority child, one at a time, at most `MAX_PRECOMPUTES_PER_PASS` per
 * pass, and none starts while `daemon.mode` is report, the pressure level is above normal or the host load is high.
 * A workspace whose last pass found the same HEAD, lockfile and install stamp is not looked at again, and a daemon that restarts looks
 * once at each live workspace, which costs a static digest when its record exists.
 */
export function createFingerprintPrecompute(log: Log, overrides: Partial<PrecomputeDependencies> = {}) {
  const d: PrecomputeDependencies = {
    signature: treeSignature,
    requests: precomputeRequests,
    run: runFingerprintPrecompute,
    loadDeferred: sizeScanDeferred,
    ...overrides,
  };
  const seen = new Map<string, string>();
  let held: string | null = null;
  const failed = (path: string, error: unknown) =>
    log('warn', 'daemon_fingerprint_precompute', `${path}: ${error instanceof Error ? error.message : String(error)}`, {
      workspace: path,
      outcome: 'failed',
    });
  return {
    async run({ config, workspaces, pressure, operation }: PrecomputeInput, act: boolean): Promise<void> {
      for (const path of seen.keys()) if (!config?.projects[path]) seen.delete(path);
      const live = workspaces.flatMap((entry) => {
        const project = entry.outcome === 'active' ? config?.projects[entry.path] : undefined;
        return project ? [{ path: entry.path, project }] : [];
      });
      const hold = live.length ? precomputeHold({ act, pressure, loadDeferred: d.loadDeferred() }) : null;
      if (hold !== held && live.length)
        log('debug', 'daemon_fingerprint_precompute', `held: ${hold ?? 'resumed'}`, { hold });
      held = hold;
      if (hold) return;
      let started = 0;
      for (const { path, project } of live) {
        if (started >= MAX_PRECOMPUTES_PER_PASS) break;
        const where = canonicalPath(path);
        let signature: string;
        try {
          signature = await d.signature(where, operation.signal);
        } catch (error) {
          if (error instanceof Error && 'reportCleanup' in error) throw error;
          operation.signal.throwIfAborted();
          failed(path, error);
          continue;
        }
        if (seen.get(path) === signature) continue;
        let requests: FingerprintPrecomputeRequest[];
        try {
          requests = await d.requests(path, project, operation);
        } catch (error) {
          if (error instanceof Error && 'reportCleanup' in error) throw error;
          operation.signal.throwIfAborted();
          failed(path, error);
          seen.set(path, signature);
          continue;
        }
        let finished = true;
        for (const request of requests) {
          if (
            started >= MAX_PRECOMPUTES_PER_PASS ||
            precomputeHold({ act, pressure, loadDeferred: d.loadDeferred() })
          ) {
            finished = false;
            break;
          }
          started++;
          const began = performance.now();
          let outcome: string;
          let reason: string | undefined;
          try {
            const result = await d.run(operation, request);
            outcome = result.outcome;
            if (result.outcome === 'skipped') reason = result.reason;
          } catch (error) {
            if (error instanceof Error && 'reportCleanup' in error) throw error;
            operation.signal.throwIfAborted();
            outcome = 'failed';
            reason = error instanceof Error ? error.message : String(error);
          }
          log(
            outcome === 'failed' ? 'warn' : 'debug',
            'daemon_fingerprint_precompute',
            `${path} ${request.platform}: ${outcome}${reason ? ` (${reason})` : ''}`,
            {
              workspace: path,
              platform: request.platform,
              outcome,
              ms: Math.round(performance.now() - began),
              ...(reason ? { reason } : {}),
            },
          );
        }
        if (finished) seen.set(path, signature);
      }
    },
  };
}
