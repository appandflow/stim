import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import {
  getConfigPath,
  getProjectSettings,
  getRepoSettings,
  loadConfig,
  withConfigLock,
  writeConfigSetting,
  type Config,
} from '../workspace/config.ts';
import { findProjectRoot, NO_PROJECT_REFUSAL } from '../workspace/project.ts';
import { readCommittedSettings, unknownSettingKeys, type SettingsObject } from '../workspace/settings.ts';
import {
  coerceSettingText,
  isJsonObject,
  isSensitiveReference,
  SETTING_SCOPES,
  settingDefinition,
  SETTINGS,
  settingValueError,
  type SettingDefinition,
  type SettingEntry,
  type SettingScope,
  type SettingsPayload,
} from '@stim-cli/core/state';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { settingDefault, stimDesktopInstalled } from '../devices/stim-desktop.ts';

const MASK = '********';

const PRECEDENCE: readonly SettingScope[] = ['workspace', 'repo', 'committed', 'machine'];

interface SettingsFailure {
  code: string;
  message: string;
  remedy: string | null;
}

class Refusal extends Error {
  readonly code: string;
  readonly remedy: string | null;

  constructor(code: string, message: string, remedy: string | null) {
    super(message);
    this.code = code;
    this.remedy = remedy;
  }
}

interface SettingsContext {
  projectPath: string | null;
  gitCommonDir: string | null;
  repoRoot: string | null;
  machine: Config | null;
  env: NodeJS.ProcessEnv;
  desktopInstalled: () => boolean;
}

function readContext(env: NodeJS.ProcessEnv): SettingsContext {
  const projectPath = findProjectRoot(process.cwd());
  const start = projectPath ?? process.cwd();
  const common = gitCommonDir(start);
  let installed: boolean | undefined;
  return {
    projectPath,
    gitCommonDir: common,
    repoRoot: common ? (repoRoot(start) ?? projectPath) : null,
    machine: loadConfig(),
    env,
    desktopInstalled: () => (installed ??= stimDesktopInstalled()),
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

function committedDirectory(context: SettingsContext, setting: SettingDefinition | null): string | null {
  return setting?.committedAt === 'repository' ? repositoryDirectory(context) : appDirectory(context);
}

function repositoryDirectory(context: SettingsContext): string | null {
  return context.repoRoot ?? context.projectPath;
}

function appDirectory(context: SettingsContext): string | null {
  return context.projectPath ?? context.repoRoot;
}

function layerFile(context: SettingsContext, scope: SettingScope, setting: SettingDefinition | null): string | null {
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
  if (scope === 'workspace') return context.projectPath ? getProjectSettings(context.projectPath) : {};
  if (scope === 'repo') return context.gitCommonDir ? getRepoSettings(context.gitCommonDir) : {};
  return readCommittedSettings(committedDirectory(context, setting));
}

function masked(setting: SettingDefinition, value: unknown): unknown {
  return setting.sensitive && value !== undefined && value !== null ? MASK : value;
}

function settingEntry(context: SettingsContext, setting: SettingDefinition): SettingEntry {
  const layers: Partial<Record<SettingScope, unknown>> = {};
  for (const scope of PRECEDENCE) {
    if (!setting.scopes.includes(scope) || layerFile(context, scope, setting) === null) continue;
    const value = valueAt(layerSettings(context, scope, setting), setting.key);
    if (value !== undefined) layers[scope] = masked(setting, value);
  }
  const envValue = setting.env ? context.env[setting.env] : undefined;
  const env = setting.env && envValue ? { name: setting.env, value: String(masked(setting, envValue)) } : undefined;
  const scopedHome = !env && setting.scopedHomeValue !== undefined && context.env.STIM_HOME;
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
    ...(env ? { env } : scopedHome ? { env: { name: 'STIM_HOME', value: context.env.STIM_HOME! } } : {}),
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
      settings: readCommittedSettings(repository),
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

function requireSetting(key: string): SettingDefinition {
  const setting = settingDefinition(key);
  if (setting) return setting;
  throw new Refusal(
    'STIM_BAD_ARG',
    `${JSON.stringify(key)} is not a Stim setting.`,
    'Run `stim settings` to list every setting, or `stim guide settings` for what each one does.',
  );
}

function readScope(raw: string | undefined, setting: SettingDefinition): SettingScope {
  if (raw === undefined) {
    if (setting.scopes.length === 1) return setting.scopes[0]!;
    throw new Refusal(
      'STIM_BAD_ARG',
      `${setting.key} can live in more than one layer, so the command needs --scope.`,
      `Pass --scope ${setting.scopes.join('|')}.`,
    );
  }
  if (!(SETTING_SCOPES as readonly string[]).includes(raw)) {
    throw new Refusal('STIM_BAD_ARG', `--scope takes ${SETTING_SCOPES.join(', ')}, not ${JSON.stringify(raw)}.`, null);
  }
  const scope = raw as SettingScope;
  if (!setting.scopes.includes(scope)) {
    throw new Refusal(
      'STIM_BAD_ARG',
      `${setting.key} is not read from the ${scope} layer.`,
      `Pass --scope ${setting.scopes.join('|')}.`,
    );
  }
  return scope;
}

function requireLayer(context: SettingsContext, scope: SettingScope, setting: SettingDefinition): string {
  const file = layerFile(context, scope, setting);
  if (file) return file;
  if (scope === 'repo') {
    throw new Refusal(
      'STIM_BAD_ARG',
      'The repo layer is keyed by a Git repository, and this directory is not inside one.',
      'Run this from inside the repository, or pick another --scope.',
    );
  }
  throw new Refusal(NO_PROJECT_REFUSAL.code, NO_PROJECT_REFUSAL.message, NO_PROJECT_REFUSAL.remedy);
}

function example(setting: SettingDefinition): string {
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

function parseSettingValue(setting: SettingDefinition, raw: string): unknown {
  const invalid = (expected: string) =>
    new Refusal(
      'STIM_BAD_ARG',
      `Invalid ${setting.key} value ${JSON.stringify(raw)}. Expected ${expected}.`,
      `For example: stim settings set ${setting.key} ${example(setting)}${setting.scopes.length > 1 ? ` --scope ${setting.scopes[0]}` : ''}`,
    );
  const kind = setting.type.kind;
  const value = coerceSettingText(setting, raw);
  const error = settingValueError(setting, value);
  if (error) throw invalid(kind === 'strings' || kind === 'object' ? `${error}, written as JSON` : error);
  return value;
}

function envSettingValue(setting: SettingDefinition, raw: string): unknown {
  const value = coerceSettingText(setting, raw);
  const error = settingValueError(setting, value);
  if (error) {
    throw new Refusal(
      'STIM_BAD_ARG',
      `Invalid ${setting.env} value ${JSON.stringify(raw)}. Expected ${error}.`,
      `Fix the environment variable, or unset it and run \`stim settings set ${setting.key} ${example(setting)}\`.`,
    );
  }
  return value;
}

function committedTarget(context: SettingsContext, setting: SettingDefinition): string {
  const directory = committedDirectory(context, setting);
  if (!directory) throw new Refusal(NO_PROJECT_REFUSAL.code, NO_PROJECT_REFUSAL.message, NO_PROJECT_REFUSAL.remedy);
  return join(directory, '.stim.json');
}

function writeCommitted(file: string, key: string, value: unknown): boolean {
  return withConfigLock(() => {
    const exists = existsSync(file);
    const text = exists ? readFileSync(file, 'utf-8') : '';
    let parsed: unknown = {};
    if (exists && text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Refusal(
          'STIM_BAD_ARG',
          `${file} is not valid JSON: ${(error as Error).message}`,
          `Repair ${file}, then run the command again.`,
        );
      }
    }
    if (!isJsonObject(parsed)) {
      throw new Refusal('STIM_BAD_ARG', `${file} is not a JSON object.`, `Repair ${file}, then run the command again.`);
    }
    const parts = key.split('.');
    const chain: SettingsObject[] = [parsed];
    for (const part of parts.slice(0, -1)) {
      const node = chain.at(-1)!;
      if (!isJsonObject(node[part])) {
        if (value === undefined) return false;
        node[part] = {};
      }
      chain.push(node[part] as SettingsObject);
    }
    const leaf = parts.at(-1)!;
    const parent = chain.at(-1)!;
    if (value === undefined) {
      if (!(leaf in parent)) return false;
      delete parent[leaf];
      for (let index = chain.length - 1; index > 0; index--) {
        if (Object.keys(chain[index]!).length > 0) break;
        delete chain[index - 1]![parts[index - 1]!];
      }
    } else {
      parent[leaf] = value;
    }
    const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? 2;
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(parsed, null, indent)}\n`);
    try {
      renameSync(tmp, file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw error;
    }
    return true;
  });
}

function writeSetting(context: SettingsContext, setting: SettingDefinition, scope: SettingScope, value: unknown) {
  if (scope === 'committed') return writeCommitted(committedTarget(context, setting), setting.key, value);
  if (scope === 'machine') return writeConfigSetting({ scope }, setting.key, value);
  if (scope === 'workspace')
    return writeConfigSetting({ scope, projectPath: context.projectPath! }, setting.key, value);
  return writeConfigSetting({ scope, gitCommonDir: context.gitCommonDir! }, setting.key, value);
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function formatOrigin(entry: SettingEntry): string {
  if (entry.origin === null) return 'unset';
  return entry.defaultReason ? `${entry.origin}: ${entry.defaultReason}` : entry.origin;
}

interface Output {
  out: (line: string) => void;
  note: (line: string) => void;
}

const CONSOLE: Output = {
  out: (line) => console.log(line),
  note: (line) => console.error(line),
};

function run(json: boolean, io: Output, action: () => void): void {
  try {
    action();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (!(error instanceof Refusal) && !(typeof code === 'string' && code.startsWith('STIM_'))) throw error;
    const failure: SettingsFailure = {
      code: code as string,
      message: (error as Error).message,
      remedy: error instanceof Refusal ? error.remedy : null,
    };
    io.note(chalk.red(`${failure.code}: ${failure.message}`));
    if (failure.remedy) io.note(chalk.dim(failure.remedy));
    if (json) io.out(JSON.stringify(failure));
    process.exitCode = 1;
  }
}

interface SubcommandOptions {
  scope?: string;
  json?: boolean;
}

function wantsJson(opts: SubcommandOptions, command: Command): boolean {
  return Boolean(opts.json ?? command.parent?.opts().json);
}

export function registerSettings(program: Command, io: Output = CONSOLE, env: NodeJS.ProcessEnv = process.env): void {
  const settings = program
    .command('settings')
    .description('Show every Stim setting with its effective value and layer, or change one')
    .option('--json', 'print every setting, its origin, and each layer value as JSON')
    .action((opts: { json?: boolean }) =>
      run(Boolean(opts.json), io, () => {
        const payload = settingsPayload(readContext(env));
        if (opts.json) {
          io.out(JSON.stringify(payload));
          return;
        }
        const width = Math.max(...payload.settings.map((entry) => entry.key.length));
        for (const entry of payload.settings) {
          const shown = entry.origin === null ? '' : formatValue(entry.value);
          io.out(`${entry.key.padEnd(width)}  ${shown}${shown ? '  ' : ''}${chalk.dim(`(${formatOrigin(entry)})`)}`);
        }
        for (const entry of payload.unknown) {
          io.note(chalk.yellow(`Warning: ${entry.key} in ${entry.file} is not read by Stim.`));
        }
      }),
    );

  settings
    .command('get <key>')
    .description('Print the effective value of a setting, or its value in one layer')
    .option('--scope <scope>', `read one layer: ${SETTING_SCOPES.join(', ')}`)
    .option('--json', 'print the setting entry as JSON')
    .action((key: string, opts: SubcommandOptions, command: Command) =>
      run(wantsJson(opts, command), io, () => {
        const setting = requireSetting(key);
        const scope = opts.scope === undefined ? null : readScope(opts.scope, setting);
        const context = readContext(env);
        const entry = settingEntry(context, setting);
        const value = scope ? (entry.layers[scope] ?? null) : entry.value;
        if (wantsJson(opts, command)) {
          io.out(JSON.stringify(scope ? { key, scope, file: layerFile(context, scope, setting), value } : entry));
          return;
        }
        if (value === null) return;
        io.out(formatValue(value));
        if (!scope && entry.defaultReason) io.note(chalk.dim(`(${formatOrigin(entry)})`));
      }),
    );

  settings
    .command('set <key> <value>')
    .description('Write a setting to one layer')
    .option('--scope <scope>', `the layer to write: ${SETTING_SCOPES.join(', ')}`)
    .option('--json', 'print the written setting as JSON')
    .action((key: string, raw: string, opts: SubcommandOptions, command: Command) =>
      run(wantsJson(opts, command), io, () => {
        const setting = requireSetting(key);
        const scope = readScope(opts.scope, setting);
        const value = parseSettingValue(setting, raw);
        if (setting.sensitive && scope === 'committed' && !isSensitiveReference(value)) {
          throw new Refusal(
            'STIM_BAD_ARG',
            `${key} is sensitive, so a committed .stim.json takes only an env: or file: reference, never the secret.`,
            `Set the secret with --scope workspace or --scope repo, or commit a reference such as env:MY_KEYSTORE_PASSWORD.`,
          );
        }
        const context = readContext(env);
        const file = requireLayer(context, scope, setting);
        const changed = writeSetting(context, setting, scope, value);
        report(io, wantsJson(opts, command), { key, scope, file, changed }, setting, readContext(env), 'set');
      }),
    );

  settings
    .command('unset <key>')
    .description('Remove a setting from one layer')
    .option('--scope <scope>', `the layer to clear: ${SETTING_SCOPES.join(', ')}`)
    .option('--json', 'print the setting after removal as JSON')
    .action((key: string, opts: SubcommandOptions, command: Command) =>
      run(wantsJson(opts, command), io, () => {
        const setting = requireSetting(key);
        const scope = readScope(opts.scope, setting);
        const context = readContext(env);
        const file = requireLayer(context, scope, setting);
        const changed = writeSetting(context, setting, scope, undefined);
        report(io, wantsJson(opts, command), { key, scope, file, changed }, setting, readContext(env), 'unset');
      }),
    );
}

function report(
  io: Output,
  json: boolean,
  write: { key: string; scope: SettingScope; file: string; changed: boolean },
  setting: SettingDefinition,
  context: SettingsContext,
  verb: 'set' | 'unset',
): void {
  const entry = settingEntry(context, setting);
  if (json) {
    io.out(JSON.stringify({ ...write, setting: entry }));
    return;
  }
  const effective = entry.origin === null ? 'unset' : `${formatValue(entry.value)} (${formatOrigin(entry)})`;
  if (!write.changed) {
    io.out(`${write.key} was not set in ${write.file}; effective value: ${effective}`);
    return;
  }
  const shown = verb === 'set' ? ` = ${formatValue(entry.layers[write.scope])}` : '';
  io.out(`${verb} ${write.key}${shown} in ${write.file}; effective value: ${effective}`);
}

export default function settingsCommand(program: Command): void {
  registerSettings(program);
}
