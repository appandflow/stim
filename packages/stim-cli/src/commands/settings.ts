import chalk from 'chalk';
import type { Command } from 'commander';
import {
  layerFile,
  readSettingsContext,
  readSettingsPayload,
  settingEntry,
  SettingsRefusal,
} from '../workspace/settings-payload.ts';
import { SETTING_SCOPES, type SettingEntry, type SettingWriteResult } from '@stim-cli/core/state';
import { mutateSetting, requireSetting, readScope } from '../workspace/settings-write.ts';

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
          io.note(
            chalk.yellow(
              `Warning: ${entry.key} in ${entry.file} is not read by Stim.${entry.replacement ? ` Run \`${entry.replacement}\` instead.` : ''}`,
            ),
          );
        }
      }),
    );

  settings
    .command('get <key>')
    .description('Print the effective value of a setting, or its value in one layer')
    .option('--scope <scope>', `read one layer: ${SETTING_SCOPES.join(', ')}`)
    .option('--json', 'print the setting entry as JSON')
    .action((key: string, opts: SubcommandOptions, command: Command) =>
      run(wantsJson(opts, command), io, async () => {
        const setting = requireSetting(key);
        const scope = opts.scope === undefined ? null : readScope(opts.scope, setting);
        const context = await readSettingsContext(process.cwd(), env, io.note);
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
      run(wantsJson(opts, command), io, async () => {
        const result = await mutateSetting(
          { action: 'set', key, value: raw, scope: opts.scope },
          { cwd: process.cwd(), env, note: io.note },
        );
        report(io, wantsJson(opts, command), result, 'set');
      }),
    );

  settings
    .command('unset <key>')
    .description('Remove a setting from one layer')
    .option('--scope <scope>', `the layer to clear: ${SETTING_SCOPES.join(', ')}`)
    .option('--json', 'print the setting after removal as JSON')
    .action((key: string, opts: SubcommandOptions, command: Command) =>
      run(wantsJson(opts, command), io, async () => {
        const result = await mutateSetting(
          { action: 'unset', key, scope: opts.scope },
          { cwd: process.cwd(), env, note: io.note },
        );
        report(io, wantsJson(opts, command), result, 'unset');
      }),
    );
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

export default function settingsCommand(program: Command): void {
  registerSettings(program);
}
