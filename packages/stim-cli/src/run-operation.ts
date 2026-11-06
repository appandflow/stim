import type { StimClient, StimOptions } from './api/types.ts';
import { GOVERNED_COMMANDS, removedEnvironmentRefusal } from './daemon/mode.ts';
import { removedSettingFindings, settingsLayers, projectSettingsContext } from './workspace/settings.ts';
import { loadConfig } from './workspace/config.ts';
import { findProjectRoot } from './workspace/project.ts';

export type Admission = NonNullable<StimOptions['admission']>;

export type ApiOperation = Exclude<keyof StimClient, 'projectRoot'>;

export type OperationEntry = { cwd: string; env: NodeJS.ProcessEnv } & (
  | { caller: 'cli'; command: string; plan: boolean }
  | { caller: 'api'; operation: ApiOperation | null; platform?: string; admission: Admission }
);

export type OperationRefusal = { code: string; message: string; remedy: string };

const API_COMMANDS: Partial<Record<ApiOperation, string>> = {
  start: 'start',
  gc: 'gc',
  collectGarbage: 'gc',
};

const PLATFORM_COMMANDS = ['ios', 'android', 'macos', 'web'];

function apiCommand(operation: ApiOperation, platform: string | undefined): string | null {
  if (operation === 'build' || operation === 'run')
    return platform !== undefined && PLATFORM_COMMANDS.includes(platform) ? platform : null;
  return API_COMMANDS[operation] ?? null;
}

/**
 * The one entry every CLI command and API operation passes before it runs. A command the daemon governs is refused
 * while the environment sets a removed setting's variable or a leftover setting turns a mechanism off; otherwise the
 * operation takes the daemon's admission (`beforeCommand`) under the CLI command it shares a policy with. A CLI
 * subcommand, `--plan`, an API operation that creates no running state and an API caller inside a Stim resident
 * (`admission: 'none'`) take no admission. API callers never run the passes in process: maintenance reads its
 * machine-global scope guards from `process.env`, not the client's environment. API `start` records its workspace's
 * use itself, after the caller's `beforeStart`, so its admission does not. Returns the refusal, or the command
 * admitted (null when none was).
 */
export async function runOperation(
  entry: OperationEntry,
): Promise<{ refusal: OperationRefusal } | { admitted: string | null }> {
  const command =
    entry.caller === 'cli'
      ? entry.command || null
      : entry.admission === 'command' && entry.operation
        ? apiCommand(entry.operation, entry.platform)
        : null;
  if (!command) return { admitted: null };
  const refusal = removedEnvironmentRefusal(command, entry.env) ?? removedConfigRefusal(command, entry.cwd, entry.env);
  if (refusal) return { refusal };
  if (entry.caller === 'cli' && entry.plan) return { admitted: null };
  try {
    const { beforeCommand } = await import('./daemon/client.ts');
    await beforeCommand(command, entry.env, {
      cwd: entry.cwd,
      recordUse: entry.caller === 'cli' || entry.operation !== 'start',
      passes: entry.caller === 'cli',
      pin: entry.caller === 'cli',
    });
  } catch {}
  return { admitted: command };
}

function removedConfigRefusal(command: string, cwd: string, env: NodeJS.ProcessEnv): OperationRefusal | null {
  if (!GOVERNED_COMMANDS.has(command)) return null;
  let found: ReturnType<typeof removedSettingFindings>;
  try {
    const root = findProjectRoot(cwd);
    found = removedSettingFindings(settingsLayers(root ? projectSettingsContext(root) : {}), loadConfig(), env).filter(
      (entry) => entry.refuses,
    );
  } catch {
    return null;
  }
  if (!found.length) return null;
  const steps = [
    ...new Set([...found.flatMap((entry) => (entry.set ? [entry.set] : [])), ...found.map((entry) => entry.unset)]),
  ];
  return {
    code: 'STIM_BAD_ARG',
    message: found.map((entry) => entry.message).join(' '),
    remedy: `Run, in order: ${steps.map((step) => `\`${step}\``).join(', ')}. Then run the command again.`,
  };
}
