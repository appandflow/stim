import { isDeepStrictEqual } from 'node:util';
import type { Fingerprint } from './evaluate.ts';
import { diffInputs } from './key.ts';

function onlyPrebuildIdsAdded(before: Fingerprint['config'], after: Fingerprint['config']): boolean {
  if (!before || !after) return false;
  const stripped = { ...after };
  for (const [section, key] of [
    ['ios', 'bundleIdentifier'],
    ['android', 'package'],
  ] as const) {
    const previous = before[section];
    const current = stripped[section];
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    const was =
      previous && typeof previous === 'object' && !Array.isArray(previous)
        ? (previous as Record<string, unknown>)
        : undefined;
    const now = current as Record<string, unknown>;
    if (now[key] === undefined || was?.[key] !== undefined) continue;
    const rest = { ...now };
    delete rest[key];
    if (was === undefined && Object.keys(rest).length === 0) delete stripped[section];
    else stripped[section] = rest;
  }
  return isDeepStrictEqual(before, stripped);
}

export function configInputsChanged(
  before: Fingerprint,
  after: Fingerprint,
  { prebuildRan }: { prebuildRan: boolean },
): string[] {
  const modules = new Set([...before.configModules, ...after.configModules]);
  return diffInputs(before.inputs, after.inputs)
    .filter((change) => change.name === 'config' || modules.has(change.name))
    .filter((change) => !(prebuildRan && change.name === 'config' && onlyPrebuildIdsAdded(before.config, after.config)))
    .map((change) => change.name);
}

export function inputsChangedDuringBuild(
  lookup: Fingerprint,
  compiled: Fingerprint,
  current: Fingerprint,
  { prebuildRan }: { prebuildRan: boolean },
): string[] {
  return [
    ...new Set([
      ...configInputsChanged(lookup, current, { prebuildRan }),
      ...diffInputs(compiled.inputs, current.inputs).map((change) => change.name),
    ]),
  ];
}
