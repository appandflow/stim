import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { cancellableSleep } from '../cancellation.ts';
import { SIM_SLIM_CATEGORIES, SIM_SLIM_FEATURES, SIM_SLIM_REQUIRED_LABELS } from './simslim-data.ts';

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const MIN_PERSISTENT_IOS = { major: 18, minor: 5 };
const SPAWN_TIMEOUT_MS = 60_000;
const READ_RETRY_DELAYS_MS = [1000, 2000, 4000];

/** launchd_sim keeps a simulator's disable overrides in the host directory CoreSimulator creates per UDID. */
const SIM_SLIM_STORE_ROOT = '/private/var/tmp';

const SLIMMABLE: ReadonlySet<string> = new Set(SIM_SLIM_CATEGORIES.flatMap((category) => category.labels));
const MANAGED: ReadonlySet<string> = new Set([...SLIMMABLE, ...SIM_SLIM_REQUIRED_LABELS]);

export interface SimSlimProfile {
  except: readonly string[];
  keep: readonly string[];
}

export interface SlimDelta {
  toDisable: string[];
  toEnable: string[];
}

export function desiredSlimLabels(profile: SimSlimProfile = { except: [], keep: [] }): Set<string> {
  const desired = new Set(SLIMMABLE);
  for (const category of SIM_SLIM_CATEGORIES) {
    if (!profile.except.includes(category.id)) continue;
    for (const label of category.labels) desired.delete(label);
  }
  for (const label of profile.keep) desired.delete(label);
  return desired;
}

/** Names of the system features the default profile turns off. */
export function slimmedFeatureNames(): string[] {
  const desired = desiredSlimLabels();
  return SIM_SLIM_FEATURES.filter((feature) => feature.labels.some((label) => desired.has(label))).map(
    (feature) => feature.name,
  );
}

const PROFILE_FIELDS = new Set(['name', 'description', 'except', 'keep']);

export function parseSlimProfile(text: string, path: string): SimSlimProfile {
  if (text.trim() === '') throw new Error(`SimSlim profile ${path} is empty; write {} for the default profile.`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse SimSlim profile ${path}: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
  }
  if (!isJsonObject(value)) throw new Error(`SimSlim profile ${path} must be a JSON object.`);
  const record = value;
  for (const key of Object.keys(record)) {
    if (!PROFILE_FIELDS.has(key)) throw new Error(`SimSlim profile ${path}: unknown field "${key}".`);
  }
  const list = (key: 'except' | 'keep'): string[] => {
    const entry = record[key];
    if (entry === undefined) return [];
    const items = Array.isArray(entry) ? entry.filter((item): item is string => typeof item === 'string') : null;
    if (!Array.isArray(entry) || items?.length !== entry.length) {
      throw new Error(`SimSlim profile ${path}: "${key}" must be an array of strings.`);
    }
    return items.map((item) => item.trim()).filter((item) => item !== '');
  };
  const except = list('except');
  for (const id of except) {
    if (!SIM_SLIM_CATEGORIES.some((category) => category.id === id)) {
      throw new Error(`SimSlim profile ${path}: unknown category "${id}". Run \`stim guide lifecycle simslim\`.`);
    }
  }
  const keep = list('keep');
  for (const label of keep) {
    if (!MANAGED.has(label)) {
      throw new Error(`SimSlim profile ${path}: "${label}" is not a slimmable service.`);
    }
  }
  return { except, keep };
}

/** Whether the iOS runtime keeps launchd disable overrides across a boot. Accepts `27.0`, `18.5.1`, `18` or a runtime id. */
export function iosRuntimeKeepsOverrides(runtime: string | null | undefined): boolean {
  const match = /(\d+)(?:[.-](\d+))?(?:[.-]\d+)*$/.exec(runtime ?? '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > MIN_PERSISTENT_IOS.major || (major === MIN_PERSISTENT_IOS.major && minor >= MIN_PERSISTENT_IOS.minor);
}

/** The transitions that move `stored` to `desired`, scoped to managed labels; every other entry stays untouched. */
export function slimDelta(stored: ReadonlyMap<string, boolean>, desired: ReadonlySet<string>): SlimDelta {
  const toDisable = [...desired].filter((label) => MANAGED.has(label) && stored.get(label) !== true);
  const toEnable = [...stored]
    .filter(([label, disabled]) => disabled && MANAGED.has(label) && !desired.has(label))
    .map(([label]) => label);
  return { toDisable: toDisable.toSorted(), toEnable: toEnable.toSorted() };
}

export function slimChangeNeeded(stored: ReadonlyMap<string, boolean>, desired: ReadonlySet<string>): boolean {
  const { toDisable, toEnable } = slimDelta(stored, desired);
  return toDisable.length + toEnable.length > 0;
}

export function storeDisablesManagedLabel(stored: ReadonlyMap<string, boolean>): boolean {
  return [...stored].some(([label, disabled]) => disabled && MANAGED.has(label));
}

export function parseSlimStore(xml: string): Map<string, boolean> {
  if (!/<plist[\s>]/.test(xml) || !/<\/plist>/.test(xml)) throw new Error('disabled.plist is not an XML property list');
  const entries = new Map<string, boolean>();
  let label: string | null = null;
  for (const token of xml.matchAll(/<key>([^<]*)<\/key>|<(true|false)\s*\/>/g)) {
    if (token[1] !== undefined) label = unescapeXml(token[1]);
    else if (label !== null) {
      entries.set(label, token[2] === 'true');
      label = null;
    }
  }
  return entries;
}

export function encodeSlimStore(entries: ReadonlyMap<string, boolean>): string {
  const body = [...entries.keys()]
    .toSorted()
    .map((label) => `\t<key>${escapeXml(label)}</key>\n\t<${entries.get(label) ? 'true' : 'false'}/>\n`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`
  );
}

function mergeSlimStore(
  stored: ReadonlyMap<string, boolean>,
  { toDisable, toEnable }: SlimDelta,
): Map<string, boolean> {
  const merged = new Map(stored);
  for (const label of toDisable) merged.set(label, true);
  for (const label of toEnable) merged.set(label, false);
  return merged;
}

export function parsePrintDisabled(output: string): Set<string> {
  const disabled = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /"([^"]+)"\s*=>\s*(disabled|true)\b/.exec(line);
    if (match?.[1] !== undefined) disabled.add(match[1]);
  }
  return disabled;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function unescapeXml(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function storeDir(udid: string, root: string): string {
  if (!UDID.test(udid)) throw new Error(`Refusing to touch launchd overrides for ${JSON.stringify(udid)}.`);
  return join(root, `com.apple.CoreSimulator.SimDevice.${udid}`);
}

function readSlimStore(udid: string, root: string = SIM_SLIM_STORE_ROOT): Map<string, boolean> {
  try {
    return parseSlimStore(readFileSync(join(storeDir(udid, root), 'disabled.plist'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

/** Merges the transitions into the store with an atomic rename, so launchd_sim never reads a partial file. */
export function writeSlimStore(udid: string, delta: SlimDelta, root: string = SIM_SLIM_STORE_ROOT): void {
  const dir = storeDir(udid, root);
  const merged = mergeSlimStore(readSlimStore(udid, root), delta);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `disabled.plist.${process.pid}.${Date.now()}`);
  try {
    writeFileSync(temp, encodeSlimStore(merged), { flag: 'wx' });
    chmodSync(temp, 0o644);
    renameSync(temp, join(dir, 'disabled.plist'));
  } finally {
    rmSync(temp, { force: true });
  }
}

async function readLiveDisabled(udid: string): Promise<Set<string>> {
  let failure: unknown;
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return parsePrintDisabled(
        await getExecutor().runFileAsync('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'print-disabled', 'system'], {
          timeoutMs: SPAWN_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        }),
      );
    } catch (error) {
      failure = error;
      const delay = READ_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await cancellableSleep(delay);
    }
  }
  throw failure;
}

export interface SimSlimOps {
  readStore(udid: string): Map<string, boolean>;
  writeStore(udid: string, delta: SlimDelta): void;
  readLive(udid: string): Promise<Set<string>>;
}

export const realSimSlimOps: SimSlimOps = {
  readStore: (udid) => readSlimStore(udid),
  writeStore: (udid, delta) => writeSlimStore(udid, delta),
  readLive: readLiveDisabled,
};

/**
 * Writes the overrides while the simulator is shut down. Never throws: a store Stim cannot write leaves the
 * simulator stock.
 */
export function writeOfflineOverrides(
  ops: SimSlimOps,
  udid: string,
  desired: ReadonlySet<string>,
  out: (line: string) => void,
): 'unchanged' | 'written' | 'failed' {
  try {
    const delta = slimDelta(ops.readStore(udid), desired);
    if (delta.toDisable.length + delta.toEnable.length === 0) return 'unchanged';
    out(
      desired.size > 0
        ? `slimming ${udid}: disabling ${delta.toDisable.length} background services before its boot`
        : `restoring stock services on ${udid} before its boot`,
    );
    ops.writeStore(udid, delta);
    return 'written';
  } catch (error) {
    out(
      `could not write the launchd overrides for ${udid}: ${error instanceof Error ? error.message : error}; running stock services`,
    );
    return 'failed';
  }
}

/** Reads the overrides back from the booted simulator. Never throws. */
export async function verifyOverrides(
  ops: SimSlimOps,
  udid: string,
  desired: ReadonlySet<string>,
  out: (line: string) => void,
): Promise<boolean> {
  try {
    const live = await ops.readLive(udid);
    const stored = new Map([...live].map((label): [string, boolean] => [label, true]));
    if (!slimChangeNeeded(stored, desired)) return true;
    out(`this simulator did not honour the launchd overrides at boot; running stock services`);
    return false;
  } catch (error) {
    out(`could not read back the launchd overrides on ${udid}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
