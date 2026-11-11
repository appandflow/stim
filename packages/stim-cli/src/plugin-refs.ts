import { AGENT_DRIVER_API_VERSION } from '@stim-cli/agent-driver/driver';
import { CACHE_PROVIDER_API_VERSION } from '@stim-cli/cache';
import { kindError, projectPlugin } from '@stim-cli/core/plugin-loader';
import { isJsonObject, settingDefinition, type PluginKind } from '@stim-cli/core/state';
import { TRANSPORT_API_VERSION } from '@stim-cli/transport';
import type { Finding } from './diagnostics/doctor.ts';
import { BUILTIN_PLUGINS, BUILTIN_PREFIX } from './plugin-builtins.ts';
import { resolveCacheProviderConfig } from './workspace/settings.ts';
import { readSettingsContext, settingEntry, type SettingsContext } from './workspace/settings-payload.ts';

/** The kind integers this Stim speaks. */
export const PLUGIN_API: Readonly<Record<PluginKind, number>> = {
  'cache-provider': CACHE_PROVIDER_API_VERSION,
  transport: TRANSPORT_API_VERSION,
  'agent-driver': AGENT_DRIVER_API_VERSION,
};

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() || 'unknown error';
}

/** The manifest's `stimPlugin.kinds`, read from disk without importing the module. */
export async function manifestKinds(reference: string, baseDir: string): Promise<Record<string, unknown>> {
  const manifest = await projectPlugin(reference, baseDir).manifest();
  const plugin = isJsonObject(manifest) ? manifest.stimPlugin : null;
  const kinds = isJsonObject(plugin) ? plugin.kinds : null;
  return isJsonObject(kinds) ? kinds : {};
}

/** Why `reference`, resolved from `baseDir`, is not a `kind` plugin this Stim accepts; null when it is. */
export async function pluginRefProblem(reference: string, baseDir: string, kind: PluginKind): Promise<string | null> {
  try {
    return await kindError(projectPlugin(reference, baseDir), reference, kind, PLUGIN_API[kind]);
  } catch (error) {
    return `${reference} does not resolve from ${baseDir}: ${reason(error)}`;
  }
}

export interface PluginEntry {
  /** `builtin:<name>`, or the reference a setting names. */
  name: string;
  source: 'builtin' | 'project';
  kinds: Record<string, unknown>;
  /** The settings that select it. */
  selectedBy: string[];
  /** Whether this Stim can load it for its kind. */
  accepted: boolean;
  reason?: string;
  /** The directory a project reference resolves from. */
  baseDir?: string;
}

/** The bundled plugins and the plugins the settings name, read from manifests only. */
export async function listPlugins(context: SettingsContext): Promise<PluginEntry[]> {
  const driverSetting = settingDefinition('hosting.agentDriver');
  const driver = driverSetting ? settingEntry(context, driverSetting).value : undefined;
  const entries: PluginEntry[] = Object.entries(BUILTIN_PLUGINS).map(([name, { kind }]) => ({
    name: `${BUILTIN_PREFIX}${name}`,
    source: 'builtin',
    kinds: { [kind]: PLUGIN_API[kind] },
    selectedBy: kind === 'agent-driver' && driver === name ? ['hosting.agentDriver'] : [],
    accepted: true,
  }));
  const provider = context.projectPath ? resolveCacheProviderConfig(context) : null;
  if (provider) {
    const problem = await pluginRefProblem(provider.provider, provider.baseDir, 'cache-provider');
    let kinds: Record<string, unknown> = {};
    try {
      kinds = await manifestKinds(provider.provider, provider.baseDir);
    } catch {}
    entries.push({
      name: provider.provider,
      source: 'project',
      kinds,
      selectedBy: ['cache.provider'],
      accepted: problem === null,
      ...(problem === null ? {} : { reason: problem }),
      baseDir: provider.baseDir,
    });
  }
  return entries;
}

/** Doctor's findings for plugin references this Stim cannot load. */
export async function pluginRefFindings(root: string, env: NodeJS.ProcessEnv): Promise<Finding[]> {
  const plugins = await listPlugins(await readSettingsContext(root, env));
  return plugins
    .filter((plugin) => !plugin.accepted)
    .map((plugin) => ({
      code: 'plugin-ref',
      level: 'cost',
      title: `${plugin.selectedBy.join(', ')} names ${plugin.name}, which this Stim cannot load`,
      detail: `${plugin.reason}. Commands that use it go on without it.`,
      fix: `Install ${plugin.name} in the project, or set ${plugin.selectedBy[0]} to a module whose package.json declares stimPlugin.kinds; \`stim plugin list\` shows what Stim accepts`,
    }));
}
