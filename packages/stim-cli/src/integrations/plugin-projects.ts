import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getConfigPath, loadConfig, machineSettingValue } from '@stim-cli/core/state';
import { holdsMarkers, readProjectPlugin, type ProjectPluginManifest } from '../project-plugin.ts';
import type { ProjectIntegration } from './project-registry.ts';

export const PLUGINS_SETTING = 'plugins';

export interface ProjectPluginEntry {
  reference: string;
  dir: string;
  package: string;
  kinds: Record<string, unknown>;
  project: ProjectPluginManifest | null;
  problem: string | null;
}

interface Snapshot {
  configPath: string;
  configStamp: string;
  manifestStamps: string[];
  entries: readonly ProjectPluginEntry[];
}

let snapshot: Snapshot | null = null;

function stamp(path: string): string {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : 'absent';
  } catch (error) {
    return `error:${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'}`;
  }
}

function configuredReferences(): unknown[] {
  try {
    const { value } = machineSettingValue(PLUGINS_SETTING, { config: loadConfig(), env: {} });
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function pluginDirs(references: readonly unknown[]): { reference: string; dir: string }[] {
  return references.flatMap((reference) => {
    if (typeof reference !== 'string') return [];
    const expanded = reference === '~' || /^~[\\/]/.test(reference) ? join(homedir(), reference.slice(2)) : reference;
    return isAbsolute(expanded) ? [{ reference, dir: resolve(expanded) }] : [];
  });
}

function readDirs(
  dirs: readonly { reference: string; dir: string }[],
  bundled: ReadonlyMap<string, string>,
): ProjectPluginEntry[] {
  const taken = new Map(bundled);
  return dirs.map(({ reference, dir }) => {
    const read = readProjectPlugin(dir, taken);
    if (read.project) taken.set(read.project.id, `the plugin at ${dir}`);
    return {
      reference,
      dir,
      package: read.package,
      kinds: read.kinds,
      project: read.project,
      problem: read.checks.find((check) => check.error !== null)?.error ?? null,
    };
  });
}

export function readProjectPlugins(
  references: readonly unknown[],
  bundled: ReadonlyMap<string, string>,
): ProjectPluginEntry[] {
  return readDirs(pluginDirs(references), bundled);
}

// @ref LLP 0023#frozen-and-experimental-plugin-kinds -- reread when config.json or a named package.json changes
export function projectPlugins(bundled: ReadonlyMap<string, string>): readonly ProjectPluginEntry[] {
  const configPath = getConfigPath();
  const configStamp = stamp(configPath);
  if (
    snapshot?.configPath === configPath &&
    snapshot.configStamp === configStamp &&
    snapshot.entries.every((entry, index) => stamp(join(entry.dir, 'package.json')) === snapshot?.manifestStamps[index])
  )
    return snapshot.entries;
  const dirs = configStamp === 'absent' ? [] : pluginDirs(configuredReferences());
  const manifestStamps = dirs.map(({ dir }) => stamp(join(dir, 'package.json')));
  const entries = readDirs(dirs, bundled);
  snapshot = { configPath, configStamp, manifestStamps, entries };
  return entries;
}

export function pluginProjectAt(
  root: string,
  bundled: ReadonlyMap<string, string>,
): (ProjectPluginEntry & { project: ProjectPluginManifest }) | null {
  for (const entry of projectPlugins(bundled)) {
    const { project } = entry;
    if (project && holdsMarkers(root, project)) return { ...entry, project };
  }
  return null;
}

export const PLUGIN_PROJECT_ID = 'plugin-project';

// @ref LLP 0023#frozen-and-experimental-plugin-kinds -- a match serves only a declared target and yields it to a bundled integration
export function pluginProjectIntegration(bundled: () => ReadonlyMap<string, string>): ProjectIntegration {
  return {
    id: PLUGIN_PROJECT_ID,
    inspect(root) {
      const plugin = pluginProjectAt(root, bundled());
      if (!plugin) return null;
      const { name, targets } = plugin.project;
      const android = targets?.android;
      const problem = {
        kind: 'not-an-app' as const,
        ...(android
          ? {
              message: `The plugin ${plugin.package} builds the ${name} project at ${root} for Android only.`,
              remedy: `Run stim android to build and run it on this workspace's emulator. Use ${name}'s own tools for anything else.`,
            }
          : {
              message: `The plugin ${plugin.package} recognises ${root} as a ${name} project and adds no build or run for it.`,
              remedy: `Build and run the ${name} project with ${name}'s own tools. stim worktree add, list and remove manage worktrees of this folder.`,
            }),
      };
      return {
        root: 'explicit',
        application: true,
        yields: true,
        platforms: () => (android ? ['android'] : []),
        validate: (operation) => (android && operation === 'android' ? null : problem),
        ...(android
          ? {
              android: async () =>
                (await import('./plugin-android.ts')).pluginAndroidProject(
                  root,
                  { name, package: plugin.package },
                  android,
                ),
            }
          : {}),
      };
    },
  };
}
