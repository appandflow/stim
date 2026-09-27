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

let built: { home: string; helper: Promise<string | null> } | null = null;

/**
 * The `stim-footprint` helper, compiled into `$STIM_HOME/helpers/` on first use, or null where it cannot be built:
 * without the Xcode command line tools, or off macOS, where `xcode-select` does not exist. The outcome is kept for
 * the life of the process, so a `status --watch` that cannot build it does not try again on every refresh.
 */
function footprintHelper(): Promise<string | null> {
  const home = configDir();
  if (built?.home !== home) built = { home, helper: buildHelper() };
  return built.helper;
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
