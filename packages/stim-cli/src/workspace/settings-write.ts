import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '@stim-cli/core';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { getConfigPath, withConfigLockAsync, writeConfigSettingAsync, type ConfigSettingsTarget } from './config.ts';
import { NO_PROJECT_REFUSAL } from './project.ts';
import type { SettingsObject } from './settings.ts';
import {
  committedDirectory,
  layerFile,
  readSettingsContext,
  settingEntry,
  settingExample,
  SettingsRefusal,
  unknownEntries,
  type SettingsContext,
} from './settings-payload.ts';
import {
  coerceSettingText,
  isJsonObject,
  isSensitiveReference,
  REPLACED_SETTINGS,
  replacementAdvice,
  SETTING_SCOPES,
  settingDefinition,
  settingValueError,
  type SettingDefinition,
  type SettingWriteResult,
  type SettingScope,
} from '@stim-cli/core/state';
import { stimDesktopInstalledAsync } from '../devices/stim-desktop.ts';
import { deleteTurnedOffRecordings, recordingLayers } from './recordings.ts';

export function requireSetting(key: string, raw?: string): SettingDefinition {
  const setting = settingDefinition(key);
  if (setting) return setting;
  const replaced = Object.hasOwn(REPLACED_SETTINGS, key) ? REPLACED_SETTINGS[key] : undefined;
  if (replaced) {
    const command = replacementAdvice(key, raw)?.command;
    throw new SettingsRefusal(
      'STIM_BAD_ARG',
      `${JSON.stringify(key)} was replaced by ${replaced.key} and is no longer read by Stim.`,
      `${command ? `Run \`${command}\`` : `Set ${replaced.key} (\`stim guide settings\` lists its values)`}, then run \`stim settings unset ${key}\` to remove the leftover key.`,
    );
  }
  throw new SettingsRefusal(
    'STIM_BAD_ARG',
    `${JSON.stringify(key)} is not a Stim setting.`,
    'Run `stim settings` to list every setting, or `stim guide settings` for what each one does.',
  );
}

function parseScopeName(raw: string): SettingScope {
  if (!(SETTING_SCOPES as readonly string[]).includes(raw)) {
    throw new SettingsRefusal(
      'STIM_BAD_ARG',
      `--scope takes ${SETTING_SCOPES.join(', ')}, not ${JSON.stringify(raw)}.`,
      null,
    );
  }
  return raw as SettingScope;
}

export function readScope(raw: string | undefined, setting: SettingDefinition): SettingScope {
  if (raw === undefined) {
    if (setting.scopes.length === 1) return setting.scopes[0]!;
    throw new SettingsRefusal(
      'STIM_BAD_ARG',
      `${setting.key} can live in more than one layer, so the command needs --scope.`,
      `Pass --scope ${setting.scopes.join('|')}.`,
    );
  }
  const scope = parseScopeName(raw);
  if (!setting.scopes.includes(scope)) {
    throw new SettingsRefusal(
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
    throw new SettingsRefusal(
      'STIM_BAD_ARG',
      'The repo layer is keyed by a Git repository, and this directory is not inside one.',
      'Run this from inside the repository, or pick another --scope.',
    );
  }
  throw new SettingsRefusal(NO_PROJECT_REFUSAL.code, NO_PROJECT_REFUSAL.message, NO_PROJECT_REFUSAL.remedy);
}

function parseSettingValue(setting: SettingDefinition, raw: string): unknown {
  const invalid = (expected: string) =>
    new SettingsRefusal(
      'STIM_BAD_ARG',
      `Invalid ${setting.key} value ${JSON.stringify(raw)}. Expected ${expected}.`,
      `For example: stim settings set ${setting.key} ${settingExample(setting)}${setting.scopes.length > 1 ? ` --scope ${setting.scopes[0]}` : ''}`,
    );
  const kind = setting.type.kind;
  const value = coerceSettingText(setting, raw);
  const error = settingValueError(setting, value);
  if (error) throw invalid(kind === 'strings' || kind === 'object' ? `${error}, written as JSON` : error);
  return value;
}

function committedTarget(context: SettingsContext, setting: SettingDefinition): string {
  const directory = committedDirectory(context, setting);
  if (!directory)
    throw new SettingsRefusal(NO_PROJECT_REFUSAL.code, NO_PROJECT_REFUSAL.message, NO_PROJECT_REFUSAL.remedy);
  return join(directory, '.stim.json');
}

function writeCommitted(file: string, key: string, value: unknown, signal?: AbortSignal): Promise<boolean> {
  return withConfigLockAsync(() => {
    const exists = existsSync(file);
    const text = exists ? readFileSync(file, 'utf-8') : '';
    let parsed: unknown = {};
    if (exists && text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new SettingsRefusal(
          'STIM_BAD_ARG',
          `${file} is not valid JSON: ${(error as Error).message}`,
          `Repair ${file}, then run the command again.`,
        );
      }
    }
    if (!isJsonObject(parsed)) {
      throw new SettingsRefusal(
        'STIM_BAD_ARG',
        `${file} is not a JSON object.`,
        `Repair ${file}, then run the command again.`,
      );
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
  }, signal);
}

function writeSetting(
  context: SettingsContext,
  setting: SettingDefinition,
  scope: SettingScope,
  value: unknown,
  signal?: AbortSignal,
) {
  if (scope === 'committed') return writeCommitted(committedTarget(context, setting), setting.key, value, signal);
  if (scope === 'machine') return writeConfigSettingAsync({ scope }, setting.key, value, signal);
  if (scope === 'workspace')
    return writeConfigSettingAsync({ scope, projectPath: context.projectPath! }, setting.key, value, signal);
  return writeConfigSettingAsync({ scope, gitCommonDir: context.gitCommonDir! }, setting.key, value, signal);
}

/** Shares CLI set/unset validation and side effects; after commit, recording cleanup finishes despite cancellation. */
export async function mutateSetting(
  request: { key: string; scope?: string } & ({ action: 'set'; value: string } | { action: 'unset' }),
  {
    cwd,
    env,
    note = () => {},
    signal,
    beforeWrite,
  }: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    note?: (line: string) => void;
    signal?: AbortSignal;
    beforeWrite?: (workspace: string | null) => void;
  },
): Promise<SettingWriteResult> {
  signal?.throwIfAborted();
  const { key } = request;
  const setting = requireSetting(key, request.action === 'set' ? request.value : undefined);
  const scope = readScope(request.scope, setting);
  const value = request.action === 'set' ? parseSettingValue(setting, request.value) : undefined;
  if (setting.sensitive && scope === 'committed' && value !== undefined && !isSensitiveReference(value)) {
    throw new SettingsRefusal(
      'STIM_BAD_ARG',
      `${key} is sensitive, so a committed .stim.json takes only an env: or file: reference, never the secret.`,
      `Set the secret with --scope workspace or --scope repo, which store it in ${getConfigPath()}, readable only by you, or commit a reference such as env:MY_KEYSTORE_PASSWORD.`,
    );
  }
  const context = await readSettingsContext(cwd, env, note, signal);
  const file = requireLayer(context, scope, setting);
  beforeWrite?.(context.projectPath);
  const apply = async (): Promise<SettingWriteResult> => {
    const recording = setting.key === 'recording.enabled' ? recordingLayers() : null;
    const changed = await writeSetting(context, setting, scope, value, signal);
    const updated = await readSettingsContext(cwd, env, undefined, undefined, context.projectPath);
    const recordingsDeleted = recording ? await deleteTurnedOffRecordings(recording) : undefined;
    let entry = settingEntry({ ...updated, desktopInstalled: () => false }, setting);
    if (entry.origin === 'default' && setting.desktopDefault !== undefined) {
      const installed = await stimDesktopInstalledAsync(process.platform, env);
      entry = settingEntry({ ...updated, desktopInstalled: () => installed }, setting);
    }
    return {
      key,
      scope,
      file,
      changed,
      setting: entry,
      ...(recordingsDeleted ? { recordingsDeleted } : {}),
    };
  };
  return key === 'recording.enabled'
    ? withWorkspaceProcessLock(configDir(), 'recording-settings', apply, { external: true, signal })
    : apply();
}

function configTarget(context: SettingsContext, scope: SettingScope): ConfigSettingsTarget | null {
  if (scope === 'workspace') return context.projectPath ? { scope, projectPath: context.projectPath } : null;
  if (scope === 'repo') return context.gitCommonDir ? { scope, gitCommonDir: context.gitCommonDir } : null;
  return scope === 'machine' ? { scope } : null;
}

export interface ReplacedSettingRemoval {
  key: string;
  replacedBy: string;
  removed: Array<{ scope: SettingScope; file: string }>;
}

/** Removes a key Stim no longer reads from every layer that has it, or from one with `scope`. */
export async function unsetReplacedSetting(
  request: { key: string; scope?: string },
  {
    cwd,
    env,
    note = () => {},
    signal,
  }: { cwd: string; env: NodeJS.ProcessEnv; note?: (line: string) => void; signal?: AbortSignal },
): Promise<ReplacedSettingRemoval> {
  signal?.throwIfAborted();
  const { key } = request;
  const only = request.scope === undefined ? undefined : parseScopeName(request.scope);
  const context = await readSettingsContext(cwd, env, note, signal);
  const removed: ReplacedSettingRemoval['removed'] = [];
  for (const entry of unknownEntries(context)) {
    if (entry.key !== key || (only && entry.scope !== only)) continue;
    const target = configTarget(context, entry.scope);
    const changed =
      entry.scope === 'committed'
        ? await writeCommitted(entry.file, key, undefined, signal)
        : target && (await writeConfigSettingAsync(target, key, undefined, signal));
    if (changed) removed.push({ scope: entry.scope, file: entry.file });
  }
  return { key, replacedBy: REPLACED_SETTINGS[key]?.key ?? key, removed };
}
