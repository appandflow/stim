import { loadConfig, removedEnvironment, settingDefinition, type Config, type DaemonMode } from '@stim-cli/core/state';

const MODE = settingDefinition('daemon.mode');

const DAEMON_MODES: readonly DaemonMode[] = ['on', 'report', 'off'];

export function parseDaemonMode(value: unknown): DaemonMode | null {
  return DAEMON_MODES.find((mode) => mode === value) ?? null;
}

/** The machine setting `daemon.mode` alone, or null when it is unset or invalid. */
export function configuredDaemonMode(): DaemonMode | null {
  try {
    return parseDaemonMode(loadConfig()?.daemon?.mode);
  } catch {
    return null;
  }
}

/** Whichever of two modes acts less: off, then report, then on. */
export function stricterDaemonMode(a: DaemonMode, b: DaemonMode): DaemonMode {
  return DAEMON_MODES.indexOf(a) >= DAEMON_MODES.indexOf(b) ? a : b;
}

/** `daemon.mode` from `STIM_DAEMON` in `env`, else off in CI, else the machine setting in `config`, else on. */
export function daemonMode(env: NodeJS.ProcessEnv = process.env, config?: Config | null): DaemonMode {
  const fromEnv = MODE?.env ? parseDaemonMode(env[MODE.env]) : null;
  if (fromEnv) return fromEnv;
  if (env.CI) return 'off';
  return (config === undefined ? configuredDaemonMode() : parseDaemonMode(config?.daemon?.mode)) ?? 'on';
}

/** Whether the platform runs a stim-daemon: Windows has none. */
export function platformHasDaemon(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** Whether this command may start a daemon process: `daemon.mode` is not off and the platform has one. */
export function spawnsDaemon(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platformHasDaemon(platform) && daemonMode(env) !== 'off';
}

export const GOVERNED_COMMANDS: ReadonlySet<string> = new Set([
  'start',
  'ios',
  'android',
  'web',
  'macos',
  'revive',
  'gc',
]);

/**
 * The refusal for a command the daemon, the pressure ladder or automatic maintenance governs while the environment
 * still sets a removed setting's variable, such as `STIM_MAINTENANCE`, naming what replaced each; null otherwise.
 */
export function removedEnvironmentRefusal(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { code: 'STIM_BAD_ARG'; message: string; remedy: string } | null {
  if (!GOVERNED_COMMANDS.has(command)) return null;
  const found = removedEnvironment(env).filter(({ replaced }) => replaced.refuses);
  if (!found.length) return null;
  const replaced = found.map(({ key, env: name, replaced: entry }) => {
    const target = entry.key ? settingDefinition(entry.key) : null;
    const instead = target?.env ? `${target.env} (${entry.replacement})` : entry.replacement;
    return `${name} (${key}) was removed; use ${instead}`;
  });
  return {
    code: 'STIM_BAD_ARG',
    message: `${replaced.join('. ')}.`,
    remedy: `Unset ${found.map(({ env: name }) => name).join(', ')}, then run the command again; \`stim guide settings\` lists what replaced each.`,
  };
}
