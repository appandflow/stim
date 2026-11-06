import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { LOCKFILES } from '@stim-cli/core/state';
import type { Provenance } from './index-store.ts';

interface Identity {
  name: string;
  version: string;
}

/** Classifies an installed package by the lockfile entry that put it there. */
export type Classifier = (dir: string, identity: Identity) => Provenance;

const CONTENT: Provenance = { mode: 'content' };
const isUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//.test(value);
const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
const toPosix = (path: string) => path.split(sep).join('/');

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** npm's `packages` map, keyed by install path: `package-lock.json` v2 and v3 and `node_modules/.package-lock.json`. */
function npm(text: string, lockDir: string): Classifier | null {
  const lock: unknown = JSON.parse(text);
  const packages = (lock as { packages?: unknown }).packages;
  const version = (lock as { lockfileVersion?: unknown }).lockfileVersion;
  if (!packages || typeof packages !== 'object' || (version !== 2 && version !== 3)) return null;
  return (dir) => {
    const entry = (packages as Record<string, Record<string, unknown> | undefined>)[toPosix(relative(lockDir, dir))];
    if (!entry || entry.link || !isUrl(entry.resolved) || typeof entry.integrity !== 'string') return CONTENT;
    return { mode: 'identity', integrity: entry.integrity, resolved: entry.resolved };
  };
}

/** The top-level keys of a YAML block mapping with their indented lines; enough for pnpm's lockfile sections. */
function yamlEntries(text: string, section: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  let inSection = false;
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inSection = line.trimEnd() === `${section}:`;
      current = null;
    } else if (inSection && /^ {2}\S/.test(line)) {
      current = [];
      entries.set(unquote(line.trim().replace(/:$/, '')).replace(/^\//, ''), current);
    } else if (inSection && current && line.trim()) current.push(line.trim());
  }
  return entries;
}

/** `{a: b, c: d}` as pnpm writes a resolution on one line. */
function flowMap(text: string): Record<string, string> {
  const body = text.replace(/^resolution:\s*\{/, '').replace(/\}\s*$/, '');
  return Object.fromEntries(
    body.split(/,\s*/).flatMap((pair) => {
      const at = pair.indexOf(':');
      return at === -1 ? [] : [[pair.slice(0, at).trim(), unquote(pair.slice(at + 1))]];
    }),
  );
}

/**
 * pnpm 6 to 9. A registry entry resolves to an integrity alone; a `patch_hash` in the installed copy's store
 * directory name adds the patch hashes the snapshots record for that version.
 */
function pnpm(text: string): Classifier {
  const packages = yamlEntries(text, 'packages');
  const snapshots = [...yamlEntries(text, 'snapshots').keys(), ...packages.keys()];
  return (dir, { name, version }) => {
    const segments = dir.split(sep);
    const store = segments.lastIndexOf('.pnpm');
    const stored = store === -1 ? null : (segments[store + 1] ?? '');
    const prefix = `${name.replace('/', '+')}@${version}`;
    if (stored !== null && !(stored.startsWith(prefix) && /^(?:$|[_(])/.test(stored.slice(prefix.length))))
      return CONTENT;
    const others = [...packages.keys()].filter(
      (key) => key.startsWith(`${name}@`) && !/^\d/.test(key.slice(name.length + 1)),
    );
    if (stored === null && others.length > 0) return CONTENT;
    const resolution = (packages.get(`${name}@${version}`) ?? []).find((line) => line.startsWith('resolution:'));
    const fields = resolution ? flowMap(resolution) : {};
    if (!fields.integrity || fields.tarball || fields.type || fields.directory) return CONTENT;
    const provenance: Provenance = { mode: 'identity', integrity: fields.integrity };
    if (stored?.includes('patch_hash=')) {
      const own = `${name}@${version}(patch_hash=`;
      const hashes = snapshots.flatMap((key) =>
        key.startsWith(own) ? [key.slice(own.length).split(')')[0] ?? ''] : [],
      );
      provenance.patch = [...new Set(hashes)].toSorted().join(',') || stored;
    }
    return provenance;
  };
}

/** Yarn 1: a registry entry has an `https` `resolved` and an `integrity`, and no entry of that version differs. */
function yarnClassic(text: string): Classifier {
  const blocks: { names: string[]; fields: Record<string, string> }[] = [];
  for (const block of text.split(/\n(?=\S)/)) {
    const [header = '', ...lines] = block.split('\n');
    if (header.startsWith('#') || !header.endsWith(':')) continue;
    const specs = header.slice(0, -1).split(/,\s*/).map(unquote);
    const fields = Object.fromEntries(
      lines.flatMap((line) => {
        const match = /^\s+(\S+)\s+(.+)$/.exec(line);
        return match?.[1] && match[2] ? [[match[1], unquote(match[2])]] : [];
      }),
    );
    blocks.push({ names: specs, fields });
  }
  return (_dir, { name, version }) => {
    const matching = blocks.filter(
      ({ names, fields }) => fields.version === version && names.some((spec) => spec.startsWith(`${name}@`)),
    );
    const registry = matching.every(
      ({ names, fields }) =>
        isUrl(fields.resolved) &&
        fields.integrity &&
        names.every((spec) => !/@(?:file|link|git\+|github|https?):/.test(spec.slice(name.length))),
    );
    if (matching.length === 0 || !registry) return CONTENT;
    const integrity = [...new Set(matching.map(({ fields }) => fields.integrity ?? ''))].toSorted().join(',');
    const resolved = [...new Set(matching.map(({ fields }) => fields.resolved ?? ''))].toSorted().join(',');
    return { mode: 'identity', integrity, resolved };
  };
}

/** Yarn 2 and later: a registry entry resolves to `<name>@npm:<version>`; a `patch:` over one adds its hash. */
function yarnBerry(text: string): Classifier {
  const resolutions: { resolution: string; checksum: string }[] = [];
  for (const block of text.split(/\n(?=\S)/)) {
    const resolution = /^\s+resolution:\s*(.+)$/m.exec(block)?.[1];
    const checksum = /^\s+checksum:\s*(.+)$/m.exec(block)?.[1];
    if (resolution) resolutions.push({ resolution: unquote(resolution), checksum: checksum ? unquote(checksum) : '' });
  }
  return (_dir, { name, version }) => {
    const own = resolutions.filter(({ resolution }) => resolution.startsWith(`${name}@`));
    const plain = `${name}@npm:${version}`;
    const patched = own.filter(({ resolution }) =>
      resolution.startsWith(`${name}@patch:${name}@npm%3A${encodeURIComponent(version)}#`),
    );
    const other = own.filter(
      ({ resolution }) => resolution !== plain && !patched.some((entry) => entry.resolution === resolution),
    );
    const registry = own.find(({ resolution }) => resolution === plain);
    if (!registry || !registry.checksum || other.some(({ resolution }) => !/@npm:\d/.test(resolution))) return CONTENT;
    const provenance: Provenance = { mode: 'identity', integrity: registry.checksum };
    const hashes = patched.map(({ resolution }) => /[&?]hash=([0-9a-f]+)/.exec(resolution)?.[1] ?? resolution);
    if (hashes.length) provenance.patch = hashes.toSorted().join(',');
    return provenance;
  };
}

/** `bun.lock`: a registry tuple names `<name>@<version>` and ends with its integrity. */
function bun(text: string, lockDir: string): Classifier | null {
  const lock: unknown = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  const packages = (lock as { packages?: unknown }).packages;
  if (!packages || typeof packages !== 'object') return null;
  return (dir, { name, version }) => {
    const key = toPosix(relative(lockDir, dir))
      .split('/')
      .filter((segment) => segment !== 'node_modules')
      .join('/');
    const tuple = (packages as Record<string, unknown>)[key];
    if (!Array.isArray(tuple) || tuple[0] !== `${name}@${version}`) return CONTENT;
    const integrity = tuple.at(-1);
    if (typeof integrity !== 'string' || !/^sha\d+-/.test(integrity) || typeof tuple[1] !== 'string') return CONTENT;
    return { mode: 'identity', integrity, ...(tuple[1] ? { resolved: tuple[1] } : {}) };
  };
}

/**
 * The classifier for the install root's lockfile, else the install state npm or pnpm keeps under `node_modules`.
 * A lockfile it cannot read (`bun.lockb`, none, a parse failure) classifies every package as content, so a reader gap
 * costs hashing, never a false hit.
 */
export function lockfileClassifier(install: string): { classify: Classifier; lockfile: string | null } {
  const candidates = [
    ...LOCKFILES.map((name) => join(install, name)),
    join(install, 'node_modules', '.package-lock.json'),
    join(install, 'node_modules', '.pnpm', 'lock.yaml'),
  ];
  for (const path of candidates) {
    const text = readText(path);
    if (text === null) continue;
    const name = basename(path);
    try {
      const classify =
        name === 'package-lock.json' || name === '.package-lock.json'
          ? npm(text, name === '.package-lock.json' ? dirname(dirname(path)) : install)
          : name === 'pnpm-lock.yaml' || name === 'lock.yaml'
            ? pnpm(text)
            : name === 'yarn.lock'
              ? text.includes('__metadata:')
                ? yarnBerry(text)
                : yarnClassic(text)
              : name === 'bun.lock'
                ? bun(text, install)
                : null;
      if (classify) return { classify, lockfile: path };
    } catch {}
  }
  return { classify: () => CONTENT, lockfile: null };
}
