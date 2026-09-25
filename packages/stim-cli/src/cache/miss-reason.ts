import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as expoFingerprint from '@expo/fingerprint';
import type { FingerprintSource } from '@expo/fingerprint';
import {
  LAST_BUILD_KEYS,
  loadConfig,
  readWorkspaceState,
  type BuildMissCategory,
  type BuildMissChange,
  type BuildMissReason,
  type StatsPlatform,
  type WorkspaceState,
} from '@stim-cli/core/state';
import { gitCommonDirOnDisk } from '../workspace/worktree.ts';
import { cacheRoot, diffFingerprintSources, storedSources, type SourceChange } from './build-cache.ts';

const MISS_CHANGE_CAP = 20;

interface MissBaseline {
  fingerprint: string;
  cacheKey: string;
  sources: FingerprintSource[];
  from: 'workspace' | 'project';
}

interface RecordedBuild {
  fingerprint: string;
  cacheKey: string;
  startedAt: string;
}

function recordedBuilds(state: WorkspaceState | null, platform: StatsPlatform): RecordedBuild[] {
  const builds: RecordedBuild[] = [];
  for (const value of [state?.[LAST_BUILD_KEYS[platform]], state?.lastBuild]) {
    const record = value as Record<string, unknown> | null | undefined;
    if (record?.platform !== platform) continue;
    const startedAt = typeof record.startedAt === 'string' ? record.startedAt : '';
    if (typeof record.fingerprint === 'string' && typeof record.cacheKey === 'string') {
      builds.push({ fingerprint: record.fingerprint, cacheKey: record.cacheKey, startedAt });
    }
    const carried = (record.missReason as { baseline?: Record<string, unknown> | null } | undefined)?.baseline;
    if (typeof carried?.fingerprint === 'string' && typeof carried.cacheKey === 'string') {
      builds.push({ fingerprint: carried.fingerprint, cacheKey: carried.cacheKey, startedAt });
    }
  }
  return builds;
}

export function projectIdentity(root: string): string | null {
  let real: string;
  try {
    real = realpathSync.native(root);
  } catch {
    return null;
  }
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      const common = gitCommonDirOnDisk(dir);
      return common ? `${common}\n${relative(dir, real)}` : null;
    }
    if (dirname(dir) === dir) return null;
  }
}

export interface MissBaselineDeps {
  readState?: (root: string) => WorkspaceState | null;
  projectRoots?: () => string[];
  identity?: (root: string) => string | null;
  sourcesOf?: (platform: string, key: string) => FingerprintSource[] | null;
}

export function findMissBaseline(
  root: string,
  platform: StatsPlatform,
  {
    readState = readWorkspaceState,
    projectRoots = () => Object.keys(loadConfig()?.projects ?? {}),
    identity = projectIdentity,
    sourcesOf = (p, key) => storedSources(p, key, cacheRoot()),
  }: MissBaselineDeps = {},
): MissBaseline | null {
  for (const build of recordedBuilds(readState(root), platform)) {
    const sources = sourcesOf(platform, build.cacheKey);
    if (sources) return { fingerprint: build.fingerprint, cacheKey: build.cacheKey, sources, from: 'workspace' };
  }

  const project = identity(root);
  if (!project) return null;
  const others: RecordedBuild[] = [];
  for (const other of projectRoots()) {
    if (other === root || identity(other) !== project) continue;
    others.push(...recordedBuilds(readState(other), platform));
  }
  for (const build of others.toSorted((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))) {
    const sources = sourcesOf(platform, build.cacheKey);
    if (sources) return { fingerprint: build.fingerprint, cacheKey: build.cacheKey, sources, from: 'project' };
  }
  return null;
}

const CATEGORY_RANK: Record<BuildMissCategory, number> = {
  'native-dependency': 0,
  'app-config': 1,
  'config-plugin': 2,
  package: 3,
  'native-dir': 4,
  file: 5,
  'app-asset': 6,
  other: 7,
  'package-scripts': 8,
  autolinking: 9,
};

function packageIn(path: string): string | null {
  const matches = [...path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
  return matches.at(-1)?.[1] ?? null;
}

function describeChange({ name, change, reasons }: SourceChange): { category: BuildMissCategory; label: string } {
  const pkg = packageIn(name);
  if (name === 'expoConfig' || reasons.includes('expoConfig')) {
    return { category: 'app-config', label: 'app config changed' };
  }
  if (pkg && reasons.some((reason) => /^(expo|rncore)Autolinking(Ios|Android)?$/.test(reason))) {
    return { category: 'native-dependency', label: `native dependency ${change}: ${pkg}` };
  }
  if (pkg && reasons.includes('expoConfigPlugins')) {
    return { category: 'config-plugin', label: `config plugin ${change}: ${pkg}` };
  }
  if (/^(expoAutolinkingConfig|rncoreAutolinkingConfig)(:|$)/.test(name)) {
    return { category: 'autolinking', label: 'autolinking config changed' };
  }
  if (name.startsWith('package:')) {
    return { category: 'package', label: `${name.slice('package:'.length)} ${change}` };
  }
  if (name === 'packageJson:scripts') return { category: 'package-scripts', label: 'package.json scripts changed' };
  if (reasons.includes('expoConfigExternalFile')) {
    return { category: 'app-asset', label: `app asset ${change}: ${name}` };
  }
  if (reasons.includes('bareNativeDir')) return { category: 'native-dir', label: `${name}/ ${change}` };
  if (reasons.length || name.includes('/') || name.includes('.')) {
    return { category: 'file', label: `${name} ${change}` };
  }
  return { category: 'other', label: `${name} ${change}` };
}

function rekeyPrefix(rekeyedBy: string[]): string {
  return rekeyedBy.length ? `${rekeyedBy.join(' and ')} changed native inputs; ` : '';
}

export function missReasonFromChanges({
  changes,
  baseline,
  rekeyedBy = [],
}: {
  changes: SourceChange[];
  baseline: BuildMissReason['baseline'];
  rekeyedBy?: string[];
}): BuildMissReason {
  const prefix = rekeyPrefix(rekeyedBy);
  if (!baseline) {
    return {
      kind: 'no-baseline',
      summary: `${prefix}no earlier build of this project in the cache to compare with`,
      changes: [],
      changeCount: 0,
      baseline: null,
      rekeyedBy,
    };
  }
  if (!changes.length) {
    return {
      kind: 'same-sources',
      summary: `${prefix}native inputs match the last build; no cached app for this configuration or target`,
      changes: [],
      changeCount: 0,
      baseline,
      rekeyedBy,
    };
  }
  const described = changes
    .map((change, index) => ({ change, index, ...describeChange(change) }))
    .toSorted((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || a.index - b.index);
  const dependencyMoved = described.some((entry) => entry.category === 'native-dependency');
  const labels = [
    ...new Set(
      described.filter((entry) => !(dependencyMoved && entry.category === 'autolinking')).map((entry) => entry.label),
    ),
  ];
  const more = labels.length > 1 ? ` (+${labels.length - 1} more)` : '';
  return {
    kind: 'changed',
    summary: `${prefix}${labels[0]}${more}`,
    changes: described
      .slice(0, MISS_CHANGE_CAP)
      .map(({ change, category }): BuildMissChange => ({ source: change.name, change: change.change, category })),
    changeCount: changes.length,
    baseline,
    rekeyedBy,
  };
}

export function explainBuildMiss({
  root,
  platform,
  current,
  rekeyedBy = [],
  baselineDeps,
  differ = expoFingerprint.diffFingerprints,
}: {
  root: string;
  platform: StatsPlatform;
  current: { hash: string; sources: FingerprintSource[] };
  rekeyedBy?: string[];
  baselineDeps?: MissBaselineDeps;
  differ?: typeof expoFingerprint.diffFingerprints | null;
}): { reason: BuildMissReason; changedNames: string[]; previousHash: string | null } {
  const baseline = findMissBaseline(root, platform, baselineDeps);
  const changes = baseline
    ? diffFingerprintSources({ previous: baseline.sources, previousHash: baseline.fingerprint, current, differ })
    : [];
  return {
    reason: missReasonFromChanges({
      changes,
      baseline: baseline
        ? { fingerprint: baseline.fingerprint, cacheKey: baseline.cacheKey, from: baseline.from }
        : null,
      rekeyedBy,
    }),
    changedNames: changes.map((change) => change.name),
    previousHash: baseline?.fingerprint ?? null,
  };
}

export function skippedMissReason(summary: string): BuildMissReason {
  return { kind: 'cache-skipped', summary, changes: [], changeCount: 0, baseline: null, rekeyedBy: [] };
}

export function fingerprintErrorMissReason(message: string): BuildMissReason {
  return {
    kind: 'fingerprint-error',
    summary: `fingerprinting failed: ${message}`,
    changes: [],
    changeCount: 0,
    baseline: null,
    rekeyedBy: [],
  };
}
