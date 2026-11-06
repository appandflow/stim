import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fingerprint } from '../fingerprint/evaluate.ts';
import { isUncertain } from '../fingerprint/key.ts';
import { git, type MutationRow } from './fingerprint-parity-rows.ts';

const exec = promisify(execFile);
const active = new Set<() => void>();
const baseEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, EXPO_NO_TELEMETRY: '1' };

export function temporaryWorktree(project: string): { root: string; cleanup(): void } {
  const source = realpathSync(project);
  const repo = git(source, 'rev-parse', '--show-toplevel');
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-parity-')));
  const checkout = join(temp, 'tree');
  const root = join(checkout, relative(repo, source));
  const cleanup = () => {
    try {
      git(repo, 'worktree', 'remove', '--force', checkout);
    } finally {
      rmSync(temp, { recursive: true, force: true });
      active.delete(cleanup);
      git(repo, 'worktree', 'prune');
    }
  };
  try {
    git(repo, 'worktree', 'add', '--quiet', '--detach', checkout, 'HEAD');
    active.add(cleanup);
    for (let dir = source; ; dir = dirname(dir)) {
      const modules = join(dir, 'node_modules');
      const dest = join(checkout, relative(repo, modules));
      if (existsSync(modules) && !lstatSync(dest, { throwIfNoEntry: false })) {
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(modules, dest, 'junction');
      }
      if (relative(repo, dir) === '') break;
    }
    return { root, cleanup };
  } catch (error) {
    if (active.has(cleanup)) cleanup();
    else rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupWorktrees(): void {
  const errors: unknown[] = [];
  for (const cleanup of [...active].toReversed()) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Temporary worktree cleanup failed');
}

export interface Measurement {
  stim: string;
  expo?: string;
  ms: number;
}
export async function hashes(
  root: string,
  platform: 'ios' | 'android',
  oracle: boolean,
  env: NodeJS.ProcessEnv = baseEnv,
): Promise<Measurement> {
  const started = performance.now();
  const result = await fingerprint(root, { platform }, { env, embedMode: 'development' });
  const ms = Math.round(performance.now() - started);
  if (isUncertain(result)) throw new Error(`Uncertain (${ms} ms): ${JSON.stringify(result)}`);
  let expo: string | undefined;
  if (oracle) {
    const module = new URL('../cache/build-cache.ts', import.meta.url).href;
    const code = `const { fingerprintProject } = await import(${JSON.stringify(module)}); const result = await fingerprintProject(process.argv[1], { platform: process.argv[2] }); console.log('PARITY_RESULT=' + JSON.stringify(result?.hash ?? null));`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code, root, platform], {
      env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expo = JSON.parse(
      stdout
        .split('\n')
        .find((line) => line.startsWith('PARITY_RESULT='))
        ?.slice(14) ?? 'null',
    );
    if (!expo) throw new Error('Expo baseline or mutation returned no hash');
  }
  return { stim: result.hash, expo, ms };
}

export async function mutation(
  row: MutationRow,
  root: string,
  baseline: Measurement,
  platform: 'ios' | 'android',
  oracle: boolean,
): Promise<{ expoMoved?: boolean; stimMoved: boolean; ms: number }> {
  let before = baseline;
  let afterRoot = root;
  const worktrees: ReturnType<typeof temporaryWorktree>[] = [];
  try {
    if (row.measure) {
      const pair = row.measure(root, {
        worktree: (dir) => {
          const checkout = temporaryWorktree(dir);
          worktrees.push(checkout);
          return checkout.root;
        },
      });
      before = await hashes(pair.before, platform, oracle);
      afterRoot = pair.after;
    } else row.apply?.(root);
    const after = await hashes(afterRoot, platform, oracle, { ...baseEnv, ...row.env?.(root) });
    return {
      expoMoved: oracle ? after.expo !== before.expo : undefined,
      stimMoved: after.stim !== before.stim,
      ms: after.ms,
    };
  } finally {
    for (const checkout of worktrees.toReversed()) checkout.cleanup();
  }
}
