import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutor } from '../exec.ts';

/** What must be identical on this Mac and a build machine for an iOS simulator build to come out the same. */
export interface IosToolchain {
  /** A digest of Stim's built code, so both sides prove they run the same Stim. */
  stimBuild: string | null;
  arch: string;
  xcode: string | null;
  simulatorSdk: string | null;
  cocoapods: string | null;
}

/** A build machine's toolchain, and the simulator runtimes it has an iPhone simulator on to build for. */
export interface WorkerToolchain extends IosToolchain {
  runtimes: string[];
}

const distDir = dirname(fileURLToPath(import.meta.url));

function quiet(file: string, args: string[]): string | null {
  return getExecutor().runFileQuiet(file, args, { timeoutMs: 20_000 });
}

function stimBuildId(dir: string = distDir): string | null {
  try {
    const hash = createHash('sha256');
    const names = readdirSync(dir)
      .filter((entry) => entry.endsWith('.mjs'))
      .toSorted();
    if (names.length === 0) return null;
    for (const name of names) {
      hash.update(name);
      hash.update(readFileSync(join(dir, name)));
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export function iosToolchain(): IosToolchain {
  const xcode = quiet('xcodebuild', ['-version']);
  return {
    stimBuild: stimBuildId(),
    arch: process.arch,
    xcode: xcode ? xcode.trim().replace(/\n/g, ' / ') : null,
    simulatorSdk: quiet('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'])?.trim() ?? null,
    cocoapods: quiet('pod', ['--version'])?.trim().split('\n').pop()?.trim() ?? null,
  };
}

/** Runtime identifiers that have at least one available iPhone simulator, from `simctl list devices -j`. */
export function iphoneRuntimes(listed: unknown): string[] {
  const devices = (listed as { devices?: Record<string, Array<{ name?: unknown; isAvailable?: unknown }>> })?.devices;
  if (!devices || typeof devices !== 'object') return [];
  return Object.entries(devices)
    .filter(([, list]) =>
      (Array.isArray(list) ? list : []).some(
        (device) => device.isAvailable !== false && typeof device.name === 'string' && device.name.startsWith('iPhone'),
      ),
    )
    .map(([runtime]) => runtime)
    .toSorted();
}

export function workerToolchain(): WorkerToolchain {
  let listed: unknown = null;
  try {
    listed = JSON.parse(quiet('xcrun', ['simctl', 'list', 'devices', 'available', '-j']) ?? 'null');
  } catch {}
  return { ...iosToolchain(), runtimes: iphoneRuntimes(listed) };
}

/** Why a build machine cannot build like this Mac; empty when it can. */
export function toolchainMismatches(local: IosToolchain, worker: WorkerToolchain, runtime: string | null): string[] {
  const out: string[] = [];
  if (!local.stimBuild || worker.stimBuild !== local.stimBuild) {
    out.push(`Stim build ${worker.stimBuild ?? 'unknown'} there, ${local.stimBuild ?? 'unknown'} here`);
  }
  if (worker.arch !== local.arch) out.push(`CPU ${worker.arch} there, ${local.arch} here`);
  if (!local.xcode || worker.xcode !== local.xcode) out.push(`Xcode ${worker.xcode} there, ${local.xcode} here`);
  if (!local.simulatorSdk || worker.simulatorSdk !== local.simulatorSdk) {
    out.push(`simulator SDK ${worker.simulatorSdk} there, ${local.simulatorSdk} here`);
  }
  if (worker.cocoapods !== local.cocoapods) out.push(`CocoaPods ${worker.cocoapods} there, ${local.cocoapods} here`);
  if (runtime && !worker.runtimes.includes(runtime)) out.push(`no iPhone simulator on ${runtime} there`);
  return out;
}
