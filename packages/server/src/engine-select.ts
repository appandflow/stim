import { dirname, join } from 'node:path';
import { bundledStim } from './environment.ts';
import type { UpdateSource } from './release-install.ts';
import { run } from './service-manager.ts';
import { ServiceError } from './service-plist.ts';

const SELECT_TIMEOUT_MS = 10 * 60_000;

/**
 * The arguments that run this build's `engine-select` on `source`: an npm release, or a directory of uploaded `.tgz`
 * packages. `explicit` is a person's choice, which passes a pin; otherwise the engine's pin, the builds marked bad
 * and the not-newer rule refuse it.
 */
export function engineSelectArgs(source: UpdateSource, setBy: string, explicit: boolean): string[] {
  const select = join(dirname(bundledStim().cli), '..', 'dist', 'engine-select.mjs');
  return [
    select,
    ...('release' in source ? ['--release', source.release] : ['--from', source.from]),
    '--set-by',
    setBy,
    ...(explicit ? ['--explicit'] : []),
  ];
}

/** What one `engine-select` run printed on its last line, as one sentence. */
export function engineSelectOutcome(output: string): { ok: boolean; message: string } {
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(output.trim().split('\n').at(-1) ?? '');
  } catch {}
  if (typeof result.flipped === 'string') return { ok: true, message: `The engine now runs build ${result.flipped}.` };
  if (typeof result.staged === 'string')
    return { ok: true, message: `Build ${result.staged} is staged; the engine switches once running work drains.` };
  if (result.busy === true) return { ok: false, message: 'Another process is changing the engine; run it again.' };
  if (typeof result.refused === 'string') return { ok: false, message: `The engine refused it: ${result.refused}.` };
  return { ok: false, message: 'engine-select printed no result.' };
}

/** Runs this build's `engine-select` on `source` and returns its outcome line, or throws its refusal. */
export async function selectEngine(source: UpdateSource, setBy: string, explicit: boolean): Promise<string> {
  const ran = await run(process.execPath, engineSelectArgs(source, setBy, explicit), process.env, SELECT_TIMEOUT_MS);
  const outcome = engineSelectOutcome(ran.stdout);
  if (!outcome.ok) throw new ServiceError(ran.ok ? outcome.message : `${outcome.message} ${ran.stderr.trim()}`);
  return outcome.message;
}
