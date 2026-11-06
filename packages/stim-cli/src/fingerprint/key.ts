import { createHash } from 'node:crypto';

/** Bumped whenever a change alters which rows exist or their bytes for any project, so every key moves at once. */
export const FINGERPRINT_SCHEMA = 1;

type InputKind = 'file' | 'package' | 'config' | 'autolinking' | 'manifest' | 'env';
export type Platform = 'ios' | 'android';
export type NativeMode = 'tracked' | 'generated';
type GitLabel = 'tracked' | 'untracked' | 'ignored';

export interface Input {
  /** A path form for a `file` row, else `package:<name>`, `config`, `env:<NAME>`, `extra:<id>` and the like. */
  name: string;
  kind: InputKind;
  /** sha256, 64 lowercase hex. */
  hash: string;
  version?: string;
  mode?: 'identity' | 'content';
  git?: GitLabel;
}

export interface Layout {
  projectPath: string | null;
  gradleRoot: string | null;
  module: string | null;
}

export interface Preimage {
  schema: number;
  platform: Platform;
  native: NativeMode;
  layout: Layout;
  inputs: [name: string, kind: InputKind, hash: string][];
}

/** Why no key could be computed. A caller builds uncached rather than use a smaller key. */
export interface Uncertain {
  uncertain: string;
  remedy?: string;
}

export interface InputChange {
  name: string;
  kind: InputKind;
  change: 'added' | 'removed' | 'changed';
}

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Code-unit order, which does not depend on the ICU data `localeCompare` reads. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function isUncertain(value: unknown): value is Uncertain {
  return typeof value === 'object' && value !== null && 'uncertain' in value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** JSON with object keys in code-unit order and no whitespace. Values JSON cannot represent exactly throw. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonical JSON has no form for ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => byCodeUnit(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON has no form for a ${typeof value}`);
}

/**
 * The rows sorted by name, with rows two stages both produced merged. Two rows of one name that disagree are a bug in
 * a stage, never a row to drop.
 */
export function mergeInputs(inputs: readonly Input[]): Input[] {
  const byName = new Map<string, Input>();
  for (const input of inputs) {
    const known = byName.get(input.name);
    if (!known) byName.set(input.name, input);
    else if (known.kind !== input.kind || known.hash !== input.hash)
      throw new Error(`two fingerprint inputs named ${input.name} disagree`);
  }
  return [...byName.values()].toSorted((a, b) => byCodeUnit(a.name, b.name));
}

export function preimage(platform: Platform, native: NativeMode, layout: Layout, inputs: readonly Input[]): Preimage {
  return {
    schema: FINGERPRINT_SCHEMA,
    platform,
    native,
    layout,
    inputs: mergeInputs(inputs).map((input) => [input.name, input.kind, input.hash]),
  };
}

export const preimageHash = (value: Preimage): string => sha256(canonicalJson(value));

/** What changed between two input lists, in name order. A row whose kind changed counts as changed. */
export function diffInputs(before: readonly Input[], after: readonly Input[]): InputChange[] {
  const a = before.toSorted((x, y) => byCodeUnit(x.name, y.name));
  const b = after.toSorted((x, y) => byCodeUnit(x.name, y.name));
  const changes: InputChange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    const order = !left ? 1 : !right ? -1 : byCodeUnit(left.name, right.name);
    if (order < 0 && left) {
      changes.push({ name: left.name, kind: left.kind, change: 'removed' });
      i++;
    } else if (order > 0 && right) {
      changes.push({ name: right.name, kind: right.kind, change: 'added' });
      j++;
    } else if (left && right) {
      if (left.hash !== right.hash || left.kind !== right.kind)
        changes.push({ name: right.name, kind: right.kind, change: 'changed' });
      i++;
      j++;
    }
  }
  return changes;
}
