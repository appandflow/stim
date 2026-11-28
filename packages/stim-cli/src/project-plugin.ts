import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';

export const PROJECT_API_VERSION = 1 as const;

/**
 * The `stimPlugin.project` block of a project plugin's package.json. Stim reads it from disk and never imports the
 * package's code: a folder that holds every marker is a project root of this type, with no build or run.
 */
export interface ProjectPluginManifest {
  /** Lowercase letters, digits and hyphens, starting with a letter, at most 40 characters; never the id of a project integration Stim bundles. */
  id: string;
  /** The project type as Stim prints it, such as `Godot`: one line of at most 40 characters. */
  name: string;
  /** One to 16 names of files directly in the project root: no path separator, no glob character. */
  markers: readonly string[];
}

export interface ProjectContractResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ProjectContractOptions {
  /** The plugin directory: an absolute path, or a path resolved from `baseDir`. A package name is not accepted. */
  reference: string;
  baseDir: string;
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const NOT_A_FILE_NAME = /[\\/*?[\]{}\p{C}]/u;
const MAX_NAME = 40;
const MAX_MARKERS = 16;

interface ManifestCheck {
  name: string;
  error: string | null;
}

interface ProjectPluginRead {
  package: string;
  kinds: Record<string, unknown>;
  checks: ManifestCheck[];
  project: ProjectPluginManifest | null;
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() || 'unknown error';
}

function kindsError(kinds: unknown, dir: string): string | null {
  const declaration = `"stimPlugin": { "kinds": { "project": ${PROJECT_API_VERSION} } }`;
  if (!isJsonObject(kinds))
    return `${dir} declares no stimPlugin.kinds in its package.json, so it is not a Stim plugin: a plugin declares ${declaration}`;
  const found = kinds.project;
  if (found === undefined)
    return `${dir} is not a project plugin: its stimPlugin.kinds declares ${Object.keys(kinds).join(', ') || 'no kind'}`;
  return found === PROJECT_API_VERSION
    ? null
    : `plugin ${dir} speaks project ${String(found)}, this stim speaks ${PROJECT_API_VERSION}: stim engine update`;
}

function idError(id: unknown): string | null {
  return typeof id === 'string' && ID.test(id)
    ? null
    : `stimPlugin.project.id is ${JSON.stringify(id)}; it must be lowercase letters, digits and hyphens, starting with a letter, at most 40 characters`;
}

function nameError(name: unknown): string | null {
  return typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME &&
    name === name.trim() &&
    !/\p{C}/u.test(name)
    ? null
    : `stimPlugin.project.name is ${JSON.stringify(name)}; it must be one line of 1 to ${MAX_NAME} characters with no surrounding space`;
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function markersError(markers: unknown): string | null {
  if (!Array.isArray(markers) || markers.length === 0 || markers.length > MAX_MARKERS)
    return `stimPlugin.project.markers must be an array of 1 to ${MAX_MARKERS} file names`;
  const bad = markers.find(
    (marker) =>
      typeof marker !== 'string' || marker === '' || marker === '.' || marker === '..' || NOT_A_FILE_NAME.test(marker),
  );
  return bad === undefined
    ? null
    : `stimPlugin.project.markers holds ${JSON.stringify(bad)}; a marker is the name of a file directly in the project root, with no path separator and no glob character`;
}

// @ref LLP 0023#frozen-and-experimental-plugin-kinds -- the manifest is read, no module is resolved or imported
export function readProjectPlugin(dir: string, reserved: ReadonlyMap<string, string>): ProjectPluginRead {
  const failed = (error: string): ProjectPluginRead => ({
    package: basename(dir),
    kinds: {},
    checks: [{ name: 'package.json is a JSON object', error }],
    project: null,
  });
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch (error) {
    return failed(
      error instanceof SyntaxError
        ? `${join(dir, 'package.json')} is not valid JSON: ${reason(error)}`
        : `${dir} has no readable package.json: ${reason(error)}`,
    );
  }
  if (!isJsonObject(manifest)) return failed(`${join(dir, 'package.json')} is not a JSON object`);
  const plugin = isJsonObject(manifest.stimPlugin) ? manifest.stimPlugin : {};
  const block = isJsonObject(plugin.project) ? plugin.project : null;
  const holder = block && typeof block.id === 'string' ? reserved.get(block.id) : undefined;
  const checks: ManifestCheck[] = [
    { name: 'package.json is a JSON object', error: null },
    { name: `stimPlugin.kinds declares project ${PROJECT_API_VERSION}`, error: kindsError(plugin.kinds, dir) },
    {
      name: 'stimPlugin.project is an object',
      error: block ? null : 'stimPlugin.project must be an object with id, name and markers',
    },
    ...(block
      ? [
          { name: 'stimPlugin.project.id is a lowercase id', error: idError(block.id) },
          {
            name: 'stimPlugin.project.id is not taken',
            error: holder ? `stimPlugin.project.id ${JSON.stringify(block.id)} is the id of ${holder}` : null,
          },
          { name: 'stimPlugin.project.name is one printable line', error: nameError(block.name) },
          { name: 'stimPlugin.project.markers are file names', error: markersError(block.markers) },
        ]
      : []),
  ];
  const { id, name, markers } = block ?? {};
  const accepted =
    checks.every((check) => check.error === null) &&
    typeof id === 'string' &&
    typeof name === 'string' &&
    isStrings(markers);
  return {
    package: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : basename(dir),
    kinds: isJsonObject(plugin.kinds) ? plugin.kinds : {},
    checks,
    project: accepted ? { id, name, markers } : null,
  };
}

export function holdsMarkers(root: string, project: ProjectPluginManifest): boolean {
  return project.markers.every((marker) => {
    try {
      return statSync(join(root, marker)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Checks a project plugin's package.json: the kind integer, and the id, name and marker rules of
 * `stimPlugin.project`. It reads the manifest only; the kind has no module to load.
 */
export async function runProjectContract(options: ProjectContractOptions): Promise<ProjectContractResult[]> {
  const { reference, baseDir } = options;
  if (!isAbsolute(reference) && !reference.startsWith('.'))
    return [
      {
        name: 'the reference is a plugin directory',
        passed: false,
        error: `${reference} is not a path: the plugins setting names a project plugin by its directory`,
      },
    ];
  const { bundledProjectIds } = await import('./integrations/projects.ts');
  return readProjectPlugin(resolve(baseDir, reference), bundledProjectIds()).checks.map(({ name, error }) =>
    error === null ? { name, passed: true } : { name, passed: false, error },
  );
}
