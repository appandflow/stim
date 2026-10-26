import { join } from 'node:path';
import {
  coerceSettingText,
  isJsonObject,
  replacementAdvice,
  SETTING_SCOPES,
  SETTINGS,
  settingDefinition,
  settingValueError,
  type SettingDefinition,
  type SettingEntry,
  type SettingScope,
  type SettingsPayload,
} from '@stim-cli/core/state';
import { getConfigPath, getProjectSettings, getRepoSettings, loadConfig, type Config } from './config.ts';
import { gitPath, killOnAbort } from './git-read.ts';
import { findCommandWorkspaceAsync } from './project.ts';
import { readCommittedSettings, removedMachineSettings, unknownSettingKeys } from './settings.ts';
import { settingDefault, stimDesktopInstalled, stimDesktopInstalledAsync } from '../devices/stim-desktop.ts';

const MASK = '********';

const PRECEDENCE: readonly SettingScope[] = ['workspace', 'repo', 'committed', 'machine'];

export class SettingsRefusal extends Error {
  readonly code: string;
  readonly remedy: string | null;

  constructor(code: string, message: string, remedy: string | null) {
    super(message);
    this.code = code;
    this.remedy = remedy;
  }
}

export interface SettingsContext {
  projectPath: string | null;
  gitCommonDir: string | null;
  repoRoot: string | null;
  machine: Config | null;
  workspace: unknown;
  repo: unknown;
  committed: { app: unknown; repository: unknown };
  env: NodeJS.ProcessEnv;
  desktopInstalled: () => boolean;
}

/** Reads layers using exactly `env`; `signal` kills Git children. `resolvedProject` pins a mutation's readback target. */
export async function readSettingsContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  note: (line: string) => void = () => {},
  signal?: AbortSignal,
  resolvedProject?: string | null,
): Promise<SettingsContext> {
  const repoRootOf = (dir: string) => gitPath(dir, ['--show-toplevel'], env, signal);
  const projectPath =
    resolvedProject === undefined ? await findCommandWorkspaceAsync(cwd, repoRootOf, note) : resolvedProject;
  const start = projectPath ?? cwd;
  const [common, root] = await Promise.all([
    gitPath(start, ['--path-format=absolute', '--git-common-dir'], env, signal),
    repoRootOf(start),
  ]);
  signal?.throwIfAborted();
  const repoRoot = common ? (root ?? projectPath) : null;
  const app = projectPath ?? repoRoot;
  const repository = repoRoot ?? projectPath;
  const committed = readCommittedSettings(app);
  let installed: boolean | undefined;
  return {
    projectPath,
    gitCommonDir: common,
    repoRoot,
    machine: loadConfig(),
    workspace: projectPath ? getProjectSettings(projectPath) : {},
    repo: common ? getRepoSettings(common) : {},
    committed: { app: committed, repository: repository === app ? committed : readCommittedSettings(repository) },
    env,
    desktopInstalled: () => (installed ??= stimDesktopInstalled(process.platform, env)),
  };
}

function valueAt(settings: unknown, key: string): unknown {
  let node = settings;
  for (const segment of key.split('.')) {
    if (!isJsonObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

export function committedDirectory(context: SettingsContext, setting: SettingDefinition | null): string | null {
  return setting?.committedAt === 'repository' ? repositoryDirectory(context) : appDirectory(context);
}

function repositoryDirectory(context: SettingsContext): string | null {
  return context.repoRoot ?? context.projectPath;
}

function appDirectory(context: SettingsContext): string | null {
  return context.projectPath ?? context.repoRoot;
}

export function layerFile(
  context: SettingsContext,
  scope: SettingScope,
  setting: SettingDefinition | null,
): string | null {
  const machineFile = getConfigPath();
  if (scope === 'machine') return machineFile;
  if (scope === 'workspace') {
    return context.projectPath ? `${machineFile} (projects["${context.projectPath}"].settings)` : null;
  }
  if (scope === 'repo') {
    return context.gitCommonDir ? `${machineFile} (repos["${context.gitCommonDir}"].settings)` : null;
  }
  const directory = committedDirectory(context, setting);
  return directory ? join(directory, '.stim.json') : null;
}

function layerSettings(context: SettingsContext, scope: SettingScope, setting: SettingDefinition | null): unknown {
  if (scope === 'machine') return context.machine ?? {};
  if (scope === 'workspace') return context.workspace;
  if (scope === 'repo') return context.repo;
  return setting?.committedAt === 'repository' ? context.committed.repository : context.committed.app;
}

function masked(setting: SettingDefinition, value: unknown): unknown {
  return setting.sensitive && value !== undefined && value !== null ? MASK : value;
}

export function settingExample(setting: SettingDefinition): string {
  switch (setting.type.kind) {
    case 'boolean':
      return 'false';
    case 'number':
      return String(setting.default ?? setting.type.minimum ?? 1);
    case 'strings':
      return `'["node_modules"]'`;
    case 'object':
      return `'{"key": "value"}'`;
    case 'choice':
      return setting.type.choices[0]!;
    default:
      return '<value>';
  }
}

function envSettingValue(setting: SettingDefinition, raw: string): unknown {
  const value = coerceSettingText(setting, raw);
  const error = settingValueError(setting, value);
  if (error) {
    throw new SettingsRefusal(
      'STIM_BAD_ARG',
      `Invalid ${setting.env} value ${JSON.stringify(raw)}. Expected ${error}.`,
      `Fix the environment variable, or unset it and run \`stim settings set ${setting.key} ${settingExample(setting)}\`.`,
    );
  }
  return value;
}

/** The refusal `stim settings get` gives for an invalid environment override of `key`, or null when it is unset, blank or valid. */
export function envSettingRefusal(key: string, env: NodeJS.ProcessEnv): SettingsRefusal | null {
  const setting = settingDefinition(key);
  const raw = setting?.env ? env[setting.env]?.trim() : undefined;
  if (!setting || !raw) return null;
  try {
    envSettingValue(setting, raw);
    return null;
  } catch (error) {
    if (error instanceof SettingsRefusal) return error;
    throw error;
  }
}

/** The refusal for an invalid configured value of a machine setting, or null when it is unset or valid. */
export function configSettingRefusal(key: string, value: unknown): SettingsRefusal | null {
  const setting = settingDefinition(key);
  const checked = typeof value === 'string' ? value.trim() : value;
  const error = setting && checked !== undefined && checked !== null ? settingValueError(setting, checked) : null;
  if (!error) return null;
  return new SettingsRefusal(
    'STIM_BAD_ARG',
    `Invalid ${key} setting ${JSON.stringify(value)}. Expected ${error}.`,
    `Replace it with \`stim settings set ${key} <value>\`; \`stim guide settings\` lists the values it takes.`,
  );
}

/** The refusal for an invalid `remote.build` that placement would read: the environment override first, else the configured value. */
export function buildPreferenceRefusal(env: NodeJS.ProcessEnv, configured: unknown): SettingsRefusal | null {
  const fromEnvironment = envSettingRefusal('remote.build', env);
  if (fromEnvironment) return fromEnvironment;
  return env.STIM_REMOTE_BUILD?.trim() ? null : configSettingRefusal('remote.build', configured);
}

export function settingEntry(context: SettingsContext, setting: SettingDefinition): SettingEntry {
  const layers: Partial<Record<SettingScope, unknown>> = {};
  for (const scope of PRECEDENCE) {
    if (!setting.scopes.includes(scope) || layerFile(context, scope, setting) === null) continue;
    const value = valueAt(layerSettings(context, scope, setting), setting.key);
    if (value !== undefined) layers[scope] = masked(setting, value);
  }
  const envValue = setting.env ? context.env[setting.env] : undefined;
  const env = setting.env && envValue ? { name: setting.env, value: String(masked(setting, envValue)) } : undefined;
  const scopedHome = !env && setting.scopedHomeValue !== undefined && context.env.STIM_HOME;
  const ci = !env && setting.ciValue !== undefined && context.env.CI;
  const winner = PRECEDENCE.find((scope) => scope in layers);
  let value: unknown = null;
  let origin: SettingEntry['origin'] = null;
  let defaultReason: string | null = null;
  if (env) {
    value = masked(setting, envSettingValue(setting, envValue!));
    origin = 'env';
  } else if (scopedHome) {
    value = setting.scopedHomeValue;
    origin = 'env';
  } else if (ci) {
    value = setting.ciValue;
    origin = 'env';
  } else if (winner) {
    value = layers[winner];
    origin = winner;
  } else if (setting.default !== undefined) {
    const fallback = settingDefault(setting, context.desktopInstalled);
    value = fallback.value;
    origin = 'default';
    defaultReason = fallback.reason;
  }
  return {
    key: setting.key,
    value,
    origin,
    layers,
    ...(env
      ? { env }
      : scopedHome
        ? { env: { name: 'STIM_HOME', value: context.env.STIM_HOME! } }
        : ci
          ? { env: { name: 'CI', value: context.env.CI! } }
          : {}),
    ...(setting.sensitive ? { sensitive: true as const } : {}),
    ...(defaultReason ? { defaultReason } : {}),
  };
}

export function unknownEntries(context: SettingsContext): SettingsPayload['unknown'] {
  const sources: Array<{ scope: SettingScope; file: string | null; settings: unknown }> = [
    {
      scope: 'machine',
      file: layerFile(context, 'machine', null),
      settings: { optimizations: context.machine?.optimizations, ...removedMachineSettings(context.machine) },
    },
    {
      scope: 'workspace',
      file: layerFile(context, 'workspace', null),
      settings: layerSettings(context, 'workspace', null),
    },
    { scope: 'repo', file: layerFile(context, 'repo', null), settings: layerSettings(context, 'repo', null) },
    {
      scope: 'committed',
      file: layerFile(context, 'committed', null),
      settings: layerSettings(context, 'committed', null),
    },
  ];
  const repository = repositoryDirectory(context);
  if (repository && repository !== appDirectory(context)) {
    sources.push({
      scope: 'committed',
      file: join(repository, '.stim.json'),
      settings: context.committed.repository,
    });
  }
  return sources.flatMap(({ scope, file, settings }) =>
    file === null
      ? []
      : unknownSettingKeys(settings).map((key) => {
          const value = valueAt(settings, key);
          const command = replacementAdvice(key, value)?.command;
          const entry = { key, scope, file, value };
          return command ? Object.assign(entry, { replacement: command }) : entry;
        }),
  );
}

function settingsPayload(context: SettingsContext): SettingsPayload {
  const files: SettingsPayload['files'] = {};
  for (const scope of SETTING_SCOPES) {
    const file = layerFile(context, scope, null);
    if (file) files[scope] = file;
  }
  return {
    project: context.projectPath,
    files,
    settings: SETTINGS.map((setting) => settingEntry(context, setting)),
    unknown: unknownEntries(context),
  };
}

/** Every setting with its effective value and layers; looks Stim Desktop up asynchronously, and only when a default depends on it. */
export async function readSettingsPayload(context: SettingsContext, signal?: AbortSignal): Promise<SettingsPayload> {
  let asked = false;
  const payload = settingsPayload({
    ...context,
    desktopInstalled: () => {
      asked = true;
      return false;
    },
  });
  if (!asked) return payload;
  const installed = await stimDesktopInstalledAsync(process.platform, context.env, killOnAbort(signal));
  signal?.throwIfAborted();
  return settingsPayload({ ...context, desktopInstalled: () => installed });
}
