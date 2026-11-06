import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
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
import { gitLocation } from './git-index.ts';
import { diffInputs, FINGERPRINT_SCHEMA, type Input, type InputChange } from './key.ts';
import { field } from './walk.ts';

const MISS_CHANGE_CAP = 20;
const SCHEMA_CHANGED = "stim's fingerprint definition changed (one-time miss)";

/** What a cache entry stored about the key it was built under: `inputs.json`, or an older Expo-shaped source list. */
type StoredInputs = unknown;

interface Baseline {
  fingerprint: string;
  cacheKey: string;
  stored: StoredInputs;
  from: 'workspace' | 'project';
}

interface RecordedBuild {
  fingerprint: string;
  cacheKey: string;
  startedAt: string;
}

function recordedBuilds(state: WorkspaceState | null, platform: StatsPlatform): RecordedBuild[] {
  const builds: RecordedBuild[] = [];
  for (const record of [state?.[LAST_BUILD_KEYS[platform]], state?.lastBuild]) {
    if (field(record, 'platform') !== platform) continue;
    const startedAt = field(record, 'startedAt');
    for (const build of [record, field(field(record, 'missReason'), 'baseline')]) {
      const fingerprint = field(build, 'fingerprint');
      const cacheKey = field(build, 'cacheKey');
      if (typeof fingerprint === 'string' && typeof cacheKey === 'string')
        builds.push({ fingerprint, cacheKey, startedAt: typeof startedAt === 'string' ? startedAt : '' });
    }
  }
  return builds;
}

function projectIdentity(root: string): string | null {
  try {
    const project = realpathSync.native(root);
    const git = gitLocation(project);
    return git ? `${realpathSync.native(git.commonDir)}\n${relative(git.top, project)}` : null;
  } catch {
    return null;
  }
}

export interface MissDeps {
  /** The stored inputs of a cache entry, or null when it kept none. */
  storedInputs: (platform: StatsPlatform, cacheKey: string) => StoredInputs | null;
  readState?: (root: string) => WorkspaceState | null;
  projectRoots?: () => string[];
  identity?: (root: string) => string | null;
}

/** The newest earlier build of this workspace, else of another checkout of the same project, with stored inputs. */
function findBaseline(
  root: string,
  platform: StatsPlatform,
  {
    storedInputs,
    readState = readWorkspaceState,
    projectRoots = () => Object.keys(loadConfig()?.projects ?? {}),
    identity = projectIdentity,
  }: MissDeps,
): Baseline | null {
  for (const build of recordedBuilds(readState(root), platform)) {
    const stored = storedInputs(platform, build.cacheKey);
    if (stored) return { ...build, stored, from: 'workspace' };
  }
  const project = identity(root);
  if (!project) return null;
  const others = projectRoots()
    .filter((other) => other !== root && identity(other) === project)
    .flatMap((other) => recordedBuilds(readState(other), platform))
    .toSorted((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  for (const build of others) {
    const stored = storedInputs(platform, build.cacheKey);
    if (stored) return { ...build, stored, from: 'project' };
  }
  return null;
}

/** The stored rows when they were written under this schema, else null: another schema's rows do not compare. */
function sameSchemaInputs(stored: StoredInputs): Input[] | null {
  const inputs = field(stored, 'inputs');
  return field(stored, 'schema') === FINGERPRINT_SCHEMA && Array.isArray(inputs) ? inputs.filter(isInput) : null;
}

const isInput = (value: unknown): value is Input =>
  ['name', 'kind', 'hash'].every((key) => typeof field(value, key) === 'string');

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

/** One label per kind: files grouped by their top directory, env names without values. */
function describeChange({ name, kind, change }: InputChange): { category: BuildMissCategory; label: string } {
  switch (kind) {
    case 'config':
      return {
        category: 'app-config',
        label: name === 'runtimeVersion' ? 'runtime version changed' : 'app config changed',
      };
    case 'autolinking':
      return { category: 'autolinking', label: 'autolinking config changed' };
    case 'package':
      return { category: 'package', label: `${name.slice('package:'.length)} ${change}` };
    case 'env':
      return { category: 'other', label: `environment variable ${name.slice(name.indexOf(':') + 1)} ${change}` };
    case 'manifest':
      return {
        category: 'file',
        label: name === 'patched-dependencies' ? 'patches changed' : 'package.json native fields changed',
      };
    case 'file': {
      const [top = name, ...rest] = name.split('/');
      const native = top === 'ios' || top === 'android';
      return {
        category: native ? 'native-dir' : 'file',
        label: rest.length ? `${top}/ ${change}` : `${name} ${change}`,
      };
    }
  }
}

function missReasonFromChanges({
  changes,
  baseline,
  rekeyedBy = [],
  schemaChanged = false,
}: {
  changes: InputChange[];
  baseline: BuildMissReason['baseline'];
  rekeyedBy?: string[];
  schemaChanged?: boolean;
}): BuildMissReason {
  const prefix = rekeyedBy.length ? `${rekeyedBy.join(' and ')} changed native inputs; ` : '';
  const base = { baseline, rekeyedBy, changes: [], changeCount: 0 };
  if (!baseline)
    return {
      ...base,
      kind: 'no-baseline',
      summary: `${prefix}no earlier build of this project in the cache to compare with`,
    };
  if (schemaChanged)
    return {
      ...base,
      kind: 'changed',
      summary: `${prefix}${SCHEMA_CHANGED}`,
      changes: [{ source: 'schema', change: 'changed', category: 'other' }],
      changeCount: 1,
    };
  if (!changes.length)
    return {
      ...base,
      kind: 'same-sources',
      summary: `${prefix}native inputs match the last build; no cached app for this configuration or target`,
    };
  const described = changes
    .map((change, index) => ({ change, index, ...describeChange(change) }))
    .toSorted((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || a.index - b.index);
  const labels = [...new Set(described.map((entry) => entry.label))];
  const more = labels.length > 1 ? ` (+${labels.length - 1} more)` : '';
  return {
    ...base,
    kind: 'changed',
    summary: `${prefix}${labels[0]}${more}`,
    changes: described
      .slice(0, MISS_CHANGE_CAP)
      .map(({ change, category }): BuildMissChange => ({ source: change.name, change: change.change, category })),
    changeCount: changes.length,
  };
}

/**
 * Why a key missed: the changes from the newest earlier build of this project whose cache entry kept its inputs. An
 * entry written under another schema, or before Stim owned the key, explains the miss as a one-time schema change.
 */
export function explainBuildMiss({
  root,
  platform,
  current,
  rekeyedBy = [],
  deps,
}: {
  root: string;
  platform: StatsPlatform;
  current: { inputs: readonly Input[] };
  rekeyedBy?: string[];
  deps: MissDeps;
}): { reason: BuildMissReason; changedNames: string[]; previousHash: string | null } {
  const baseline = findBaseline(root, platform, deps);
  const before = baseline ? sameSchemaInputs(baseline.stored) : null;
  const changes = before ? diffInputs(before, current.inputs) : [];
  return {
    reason: missReasonFromChanges({
      changes,
      baseline: baseline
        ? { fingerprint: baseline.fingerprint, cacheKey: baseline.cacheKey, from: baseline.from }
        : null,
      rekeyedBy,
      schemaChanged: baseline !== null && before === null,
    }),
    changedNames: changes.map((change) => change.name),
    previousHash: baseline?.fingerprint ?? null,
  };
}
