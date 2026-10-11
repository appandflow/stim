import type { ChildProcess } from 'node:child_process';
import { join, sep } from 'node:path';
import {
  coerceSettingText,
  isJsonObject,
  SETTING_SCOPES,
  SETTINGS,
  settingValueError,
  type SettingDefinition,
  type SettingEntry,
  type SettingScope,
  type SettingsPayload,
} from '@stim-cli/core/state';
import { getConfigPath, getProjectSettings, getRepoSettings, loadConfig, type Config } from './config.ts';
import { gitAsync } from './git.ts';
import { findCommandWorkspaceAsync } from './project.ts';
import { readCommittedSettings, unknownSettingKeys } from './settings.ts';
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

function childEnvironment(env: NodeJS.ProcessEnv): { env: Record<string, string>; omitEnv: string[] } {
  return {
    env: Object.fromEntries(
      Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
    ),
    omitEnv: Object.keys(process.env).filter((name) => env[name] === undefined),
  };
}

function killOnAbort(signal: AbortSignal | undefined): (child: ChildProcess) => void {
  return (child) => {
    if (!signal) return;
    if (signal.aborted) return void child.kill('SIGKILL');
    const kill = () => child.kill('SIGKILL');
    signal.addEventListener('abort', kill, { once: true });
    child.once('close', () => signal.removeEventListener('abort', kill));
  };
}

function gitPath(cwd: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | null> {
  return gitAsync(cwd, ['rev-parse', ...args], { ...childEnvironment(env), onSpawn: killOnAbort(signal) }).then(
    (out) => {
      const path = out.trim();
      if (!path) return null;
      return sep === '/' ? path : path.replaceAll('/', sep);
    },
    () => null,
  );
}

/** Reads the layers a settings lookup in `cwd` sees, running Git with exactly `env`; `signal` kills its Git children. */
export async function readSettingsContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  note: (line: string) => void = () => {},
  signal?: AbortSignal,
): Promise<SettingsContext> {
  const repoRootOf = (dir: string) => gitPath(dir, ['--show-toplevel'], env, signal);
  const projectPath = await findCommandWorkspaceAsync(cwd, repoRootOf, note);
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

function unknownEntries(context: SettingsContext): SettingsPayload['unknown'] {
  const sources: Array<{ scope: SettingScope; file: string | null; settings: unknown }> = [
    {
      scope: 'machine',
      file: layerFile(context, 'machine', null),
      settings: { optimizations: context.machine?.optimizations },
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
      : unknownSettingKeys(settings).map((key) => ({ key, scope, file, value: valueAt(settings, key) })),
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
