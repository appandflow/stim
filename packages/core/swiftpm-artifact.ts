import type { BuildSwiftpmArtifactQuery } from './protocol.ts';
import { isJsonObject } from './state/json-file.ts';
import { validMacosResourceDestination } from './macos-resources.ts';
import { stimIdentity } from './react-native-artifact.ts';

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const path = (value: unknown): value is string =>
  text(value) &&
  !/[\\:]/.test(value) &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
const strings = (value: unknown, valid: (value: unknown) => value is string): value is string[] =>
  Array.isArray(value) && value.length <= 1000 && value.every(valid);
const normalized = (values: string[]) => [...new Set(values)].toSorted();

/** Validates and canonicalizes the source and build choices of a completed SwiftPM peer artifact. */
export function swiftpmArtifactQuery(value: unknown): BuildSwiftpmArtifactQuery | null {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some(
      (key) => !['project', 'sourceDigest', 'stimBuild', 'compat', 'inputs', 'build'].includes(key),
    ) ||
    typeof value.project !== 'string' ||
    (value.project !== '' && !path(value.project)) ||
    typeof value.sourceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sourceDigest)
  )
    return null;
  const stim = stimIdentity(value);
  if (!stim) return null;
  const { inputs, build } = value;
  if (
    !isJsonObject(inputs) ||
    inputs.complete !== true ||
    Object.keys(inputs).some((key) => !['complete', 'ignored', 'outputs', 'localFiles', 'environment'].includes(key)) ||
    !strings(inputs.ignored, path) ||
    !strings(inputs.outputs, path) ||
    !strings(inputs.localFiles, text) ||
    !strings(
      inputs.environment,
      (name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    ) ||
    !isJsonObject(build) ||
    Object.keys(build).some((key) => !['product', 'infoPlist', 'resources', 'assetCatalog'].includes(key)) ||
    typeof build.product !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(build.product) ||
    !path(build.infoPlist) ||
    !isJsonObject(build.resources) ||
    Object.keys(build.resources).length > 256 ||
    (build.assetCatalog !== null && !path(build.assetCatalog))
  )
    return null;
  const resourceEntries: [string, string][] = [];
  for (const [destination, source] of Object.entries(build.resources).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!validMacosResourceDestination(destination) || !path(source)) return null;
    resourceEntries.push([destination, source]);
  }
  return {
    project: value.project,
    sourceDigest: value.sourceDigest,
    ...stim,
    inputs: {
      complete: true,
      ignored: normalized(inputs.ignored),
      outputs: normalized(inputs.outputs),
      localFiles: normalized(inputs.localFiles),
      environment: normalized(inputs.environment),
    },
    build: {
      product: build.product,
      infoPlist: build.infoPlist,
      resources: Object.fromEntries(resourceEntries),
      assetCatalog: build.assetCatalog,
    },
  };
}
