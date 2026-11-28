import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';

export const PROJECT_API_VERSION = 1 as const;

/**
 * One build command of a project plugin target: the executable, then its arguments. The executable is an absolute
 * path or a bare command name that Stim finds on `PATH`, never a relative path, and on Windows a `.exe`. Stim runs
 * the list in the project root with no shell. An argument that is exactly `{root}` becomes the project root and one
 * that is exactly `{output}` becomes the file Stim expects the build to write; `{output}` appears exactly once, and
 * no other argument contains a `{name}`.
 */
export type ProjectPluginCommand = readonly [executable: string, ...args: string[]];

/** The Android build of a project plugin: `stim android` runs it, then installs and launches the APK it wrote. */
export interface ProjectPluginAndroidTarget {
  build: {
    /** The command for the default build and for `--variant debug`. */
    debug: ProjectPluginCommand;
    /** The command for `--variant release`. Without it a release build refuses. */
    release?: ProjectPluginCommand;
    /** What the command writes at `{output}`: one signed, standalone APK. */
    output: 'apk';
  };
}

/**
 * The `stimPlugin.project` block of a project plugin's package.json. Stim reads it from disk and never imports the
 * package's code: a folder that holds every marker is a project root of this type. Without `targets` Stim builds and
 * runs nothing there.
 */
export interface ProjectPluginManifest {
  /** Lowercase letters, digits and hyphens, starting with a letter, at most 40 characters; never the id of a project integration Stim bundles. */
  id: string;
  /** The project type as Stim prints it, such as `Godot`: one line of at most 40 characters. */
  name: string;
  /** One to 16 names of files directly in the project root: no path separator, no glob character. */
  markers: readonly string[];
  /** The builds the plugin declares. `android` is the only target. */
  targets?: { android?: ProjectPluginAndroidTarget };
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

const PLACEHOLDER = /\{\w+\}/;

function unknownKey(value: Record<string, unknown>, known: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !known.includes(key));
}

// @ref LLP 0014#use-fixed-invocations -- the executable is an absolute path or a bare name, never a path into the checkout
function readCommand(command: unknown, at: string): { command: ProjectPluginCommand } | { error: string } {
  const [executable, ...args] = isStrings(command) ? command : [];
  if (!isStrings(command) || executable === undefined || command.includes(''))
    return { error: `${at} must be an array of non-empty strings: the executable, then its arguments` };
  if (
    executable !== executable.trim() ||
    PLACEHOLDER.test(executable) ||
    (!isAbsolute(executable) && /[\\/]/.test(executable))
  )
    return {
      error: `${at} starts with ${JSON.stringify(executable)}; the executable is an absolute path or a bare command name found on PATH`,
    };
  const reserved = args.find((arg) => PLACEHOLDER.test(arg) && arg !== '{root}' && arg !== '{output}');
  if (reserved !== undefined)
    return {
      error: `${at} holds ${JSON.stringify(reserved)}; {root} and {output} are the only placeholders, each as a whole argument`,
    };
  const outputs = args.filter((arg) => arg === '{output}').length;
  return outputs === 1
    ? { command: [executable, ...args] }
    : {
        error: `${at} names {output} as a whole argument ${outputs} times; the build writes its APK to exactly one {output}`,
      };
}

// @ref LLP 0023#frozen-and-experimental-plugin-kinds -- a target field this Stim does not know rejects the manifest
function readTargets(targets: unknown): { targets?: ProjectPluginManifest['targets'] } | { error: string } {
  const at = 'stimPlugin.project.targets';
  if (targets === undefined) return {};
  if (!isJsonObject(targets)) return { error: `${at} must be an object` };
  const target = unknownKey(targets, ['android']);
  if (target !== undefined)
    return { error: `${at} declares ${JSON.stringify(target)}; android is the only target this stim builds` };
  const { android } = targets;
  if (android === undefined) return { targets: {} };
  if (!isJsonObject(android) || !isJsonObject(android.build))
    return { error: `${at}.android must be an object with a build object` };
  const { build } = android;
  const unknown = unknownKey(android, ['build']) ?? unknownKey(build, ['debug', 'release', 'output']);
  if (unknown !== undefined)
    return { error: `${at}.android holds ${JSON.stringify(unknown)}, which this stim does not know` };
  if (build.output !== 'apk')
    return { error: `${at}.android.build.output is ${JSON.stringify(build.output)}; it must be "apk"` };
  const debug = readCommand(build.debug, `${at}.android.build.debug`);
  if ('error' in debug) return debug;
  const release = build.release === undefined ? null : readCommand(build.release, `${at}.android.build.release`);
  if (release && 'error' in release) return release;
  return {
    targets: {
      android: { build: { debug: debug.command, ...(release ? { release: release.command } : {}), output: 'apk' } },
    },
  };
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
  const declared = readTargets(block?.targets);
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
          ...(block.targets === undefined
            ? []
            : [
                {
                  name: 'stimPlugin.project.targets declares builds Stim can run',
                  error: 'error' in declared ? declared.error : null,
                },
              ]),
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
    project: accepted
      ? { id, name, markers, ...('targets' in declared && declared.targets ? { targets: declared.targets } : {}) }
      : null,
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
 * Checks a project plugin's package.json: the kind integer, and the id, name, marker and target rules of
 * `stimPlugin.project`. It reads the manifest only and runs no declared command; the kind has no module to load.
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
