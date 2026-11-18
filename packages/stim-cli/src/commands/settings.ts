import chalk from 'chalk';
import { defineOp, type Op } from '../cli/define-op.ts';
import {
  layerFile,
  readSettingsContext,
  readSettingsPayload,
  settingEntry,
  SettingsRefusal,
} from '../workspace/settings-payload.ts';
import {
  REMOVED_SETTINGS,
  settingDefinition,
  SETTING_SCOPES,
  type SettingEntry,
  type SettingWriteResult,
} from '@stim-cli/core/state';
import {
  mutateSetting,
  readScope,
  requireSetting,
  unsetReplacedSetting,
  type ReplacedSettingRemoval,
} from '../workspace/settings-write.ts';

interface SettingsFailure {
  code: string;
  message: string;
  remedy: string | null;
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

async function run(json: boolean, io: Output, action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (!(error instanceof SettingsRefusal) && !(typeof code === 'string' && code.startsWith('STIM_'))) throw error;
    const failure: SettingsFailure = {
      code: code as string,
      message: (error as Error).message,
      remedy: error instanceof SettingsRefusal ? error.remedy : null,
    };
    io.note(chalk.red(`${failure.code}: ${failure.message}`));
    if (failure.remedy) io.note(chalk.dim(failure.remedy));
    if (json) io.out(JSON.stringify(failure));
    process.exitCode = 1;
  }
}

function wantsJson(own: boolean | undefined, parent: Readonly<Record<string, unknown>>): boolean {
  return Boolean(own ?? parent.json);
}

export function settingsOp(io: Output = CONSOLE, env: NodeJS.ProcessEnv = process.env): Op {
  const get = defineOp({
    name: 'get',
    arguments: '<key>',
    description: 'Print the effective value of a setting, or its value in one layer',
    options: {
      scope: { flags: '--scope <scope>', description: `read one layer: ${SETTING_SCOPES.join(', ')}` },
      json: { flags: '--json', description: 'print the setting entry as JSON' },
    },
    run: ({ args: [key], options: opts, parent }) =>
      run(wantsJson(opts.json, parent), io, async () => {
        const setting = requireSetting(key);
        const scope = opts.scope === undefined ? null : readScope(opts.scope, setting);
        const context = await readSettingsContext(process.cwd(), env, io.note);
        const entry = settingEntry(context, setting);
        const value = scope ? (entry.layers[scope] ?? null) : entry.value;
        if (wantsJson(opts.json, parent)) {
          io.out(JSON.stringify(scope ? { key, scope, file: layerFile(context, scope, setting), value } : entry));
          return;
        }
        if (value === null) return;
        io.out(formatValue(value));
        if (!scope && entry.defaultReason) io.note(chalk.dim(`(${formatOrigin(entry)})`));
      }),
  });

  const set = defineOp({
    name: 'set',
    arguments: '<key> <value>',
    description: 'Write a setting to one layer',
    options: {
      scope: { flags: '--scope <scope>', description: `the layer to write: ${SETTING_SCOPES.join(', ')}` },
      json: { flags: '--json', description: 'print the written setting as JSON' },
    },
    run: ({ args: [key, raw], options: opts, parent }) =>
      run(wantsJson(opts.json, parent), io, async () => {
        const result = await mutateSetting(
          { action: 'set', key, value: raw, scope: opts.scope },
          { cwd: process.cwd(), env, note: io.note },
        );
        report(io, wantsJson(opts.json, parent), result, 'set');
      }),
  });

  const unset = defineOp({
    name: 'unset',
    arguments: '<key>',
    description: 'Remove a setting from one layer',
    options: {
      scope: { flags: '--scope <scope>', description: `the layer to clear: ${SETTING_SCOPES.join(', ')}` },
      json: { flags: '--json', description: 'print the setting after removal as JSON' },
    },
    run: ({ args: [key], options: opts, parent }) =>
      run(wantsJson(opts.json, parent), io, async () => {
        if (REMOVED_SETTINGS.has(key) && !settingDefinition(key)) {
          const removal = await unsetReplacedSetting(
            { key, scope: opts.scope },
            { cwd: process.cwd(), env, note: io.note },
          );
          reportRemoval(io, wantsJson(opts.json, parent), removal, opts.scope);
          return;
        }
        const result = await mutateSetting(
          { action: 'unset', key, scope: opts.scope },
          { cwd: process.cwd(), env, note: io.note },
        );
        report(io, wantsJson(opts.json, parent), result, 'unset');
      }),
  });

  return defineOp({
    name: 'settings',
    description: 'Show every Stim setting with its effective value and layer, or change one',
    options: {
      json: { flags: '--json', description: 'print every setting, its origin, and each layer value as JSON' },
    },
    commands: [get, set, unset],
    run: ({ options: opts }) =>
      run(Boolean(opts.json), io, async () => {
        const payload = await readSettingsPayload(await readSettingsContext(process.cwd(), env, io.note));
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
  });
}

function reportRemoval(io: Output, json: boolean, removal: ReplacedSettingRemoval, scope?: string): void {
  if (json) {
    io.out(JSON.stringify(removal));
    return;
  }
  for (const { file } of removal.removed) io.out(`unset ${removal.key} in ${file}`);
  if (removal.removed.length === 0)
    io.out(`${removal.key} was not set in ${scope ? `the ${scope} layer` : 'any layer'}.`);
}

function report(io: Output, json: boolean, result: SettingWriteResult, verb: 'set' | 'unset'): void {
  const { setting: entry, recordingsDeleted, ...write } = result;
  if (json) {
    io.out(JSON.stringify(result));
    return;
  }
  for (const workspace of recordingsDeleted ?? []) io.note(`Deleted the device recordings of ${workspace}.`);
  const effective = entry.origin === null ? 'unset' : `${formatValue(entry.value)} (${formatOrigin(entry)})`;
  if (!write.changed) {
    io.out(`${write.key} was not set in ${write.file}; effective value: ${effective}`);
    return;
  }
  const shown = verb === 'set' ? ` = ${formatValue(entry.layers[write.scope])}` : '';
  io.out(`${verb} ${write.key}${shown} in ${write.file}; effective value: ${effective}`);
}

const settings: Op = settingsOp();

export default settings;
