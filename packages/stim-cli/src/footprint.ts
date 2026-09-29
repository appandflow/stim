import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compiledHelper, configDir } from '@stim-cli/core';
import { getExecutor } from './exec.ts';

const SOURCE = 'stim-footprint.swift';
const COMPILE_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 5000;

function helperSource(): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'src') return fileURLToPath(new URL(`../helper/${SOURCE}`, import.meta.url));
  return join(dirname(here), SOURCE);
}

async function buildHelper(): Promise<string | null> {
  const exec = getExecutor();
  if (!exec.runFileQuiet('xcode-select', ['-p'], { timeoutMs: READ_TIMEOUT_MS })) return null;
  const source = helperSource();
  try {
    return await compiledHelper({
      dir: join(configDir(), 'helpers'),
      name: 'stim-footprint',
      inputs: [source],
      version: '',
      compile: async (output) => {
        await exec.runFileAsync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-o', output, source], {
          timeoutMs: COMPILE_TIMEOUT_MS,
        });
      },
    });
  } catch {
    return null;
  }
}

const RETRY_BACKOFF_INITIAL_MS = 10_000;
const RETRY_BACKOFF_MAX_MS = 10 * 60_000;

let built: { home: string; promise: Promise<string | null> } | null = null;
let failure: { home: string; nextRetryAt: number; backoffMs: number } | null = null;

/**
 * The `stim-footprint` helper, compiled into `$STIM_HOME/helpers/` on first use, or null where it cannot be built:
 * without the Xcode command line tools, or off macOS, where `xcode-select` does not exist. A successful build is
 * kept for the life of the process. A failed build is retried with a doubling backoff (starting at
 * `RETRY_BACKOFF_INITIAL_MS`, capped at `RETRY_BACKOFF_MAX_MS`) instead of pinned forever: a `status --watch`
 * whose first lookup hits a transient failure (a stalled `xcode-select`, a dev-checkout rebuild that has
 * removed `dist/stim-footprint.swift`) recovers once the cause clears, while a machine with no Xcode command
 * line tools at all still does not retry on every refresh.
 */
function footprintHelper(): Promise<string | null> {
  const home = configDir();
  if (built?.home === home) return built.promise;
  if (failure?.home === home && Date.now() < failure.nextRetryAt) return Promise.resolve(null);
  const promise = buildHelper().then((helper) => {
    if (helper === null) {
      const backoffMs =
        failure?.home === home ? Math.min(failure.backoffMs * 2, RETRY_BACKOFF_MAX_MS) : RETRY_BACKOFF_INITIAL_MS;
      failure = { home, nextRetryAt: Date.now() + backoffMs, backoffMs };
      if (built?.promise === promise) built = null;
      return null;
    }
    failure = null;
    return helper;
  });
  built = { home, promise };
  return promise;
}

/** Parses the helper's `<pid> <bytes>` lines into footprint bytes by pid. */
function parseFootprints(output: string): Map<number, number> {
  const footprints = new Map<number, number>();
  for (const line of output.split('\n')) {
    const match = /^(\d+) (\d+)$/.exec(line.trim());
    if (match) footprints.set(Number(match[1]), Number(match[2]));
  }
  return footprints;
}

/** Every readable process's physical footprint in bytes, or null when the helper is unavailable or fails. */
export async function readFootprints(): Promise<Map<number, number> | null> {
  const helper = await footprintHelper();
  const output = helper ? getExecutor().runFileQuiet(helper, [], { timeoutMs: READ_TIMEOUT_MS }) : null;
  return output === null ? null : parseFootprints(output);
}
