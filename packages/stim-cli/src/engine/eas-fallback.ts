import type { EasFallbackCheck } from '../device-host/placement.ts';
import { getExecutor } from '../exec.ts';
import { readMetroTunnel, readRemoteSession } from '../supervisor/state.ts';
import { getProject } from '../workspace/config.ts';
import { isEasAuthFailureText, resolveEasCliBin } from './remote-cache.ts';
import { readInstalledEasCliVersion } from './device-remote.ts';
import { easCliSupport, MIN_EAS_CLI_DEVICE_VERSION, MIN_EAS_CLI_SIMULATOR_VERSION } from './eas-simulator.ts';
import { detectProviders, planMetroReach, PUBLIC_METRO_ENV, type TunnelMode } from './metro-reach.ts';

const AVAILABILITY_TIMEOUT_MS = 30_000;

function unusable(code: string, reason: string): EasFallbackCheck {
  return { usable: false, code, reason };
}

/** Reads `eas simulator:availability --json`: `{"available": true, ...}` on stdout, or a failure on stderr. */
export function parseSimulatorAvailability(
  outcome: { stdout: string } | { failure: string; timedOut?: boolean },
): EasFallbackCheck {
  if ('failure' in outcome) {
    if (outcome.timedOut) return unusable('eas-unavailable', 'eas simulator:availability timed out');
    const detail = outcome.failure
      .split('\n')
      .map((line) => line.trim())
      .find(
        (line) =>
          line && !/is now available\.$|^(To upgrade|npm install|Proceeding with|\(node:|\(Use `node)/.test(line),
      );
    if (isEasAuthFailureText(outcome.failure))
      return unusable('eas-logged-out', 'eas-cli is not logged in (run eas login or set EXPO_TOKEN)');
    return unusable('eas-unavailable', `eas simulator:availability failed${detail ? `: ${detail}` : ''}`);
  }
  let data: unknown = null;
  try {
    data = JSON.parse(outcome.stdout.slice(outcome.stdout.indexOf('{')));
  } catch {}
  if (typeof data !== 'object' || data === null || typeof (data as { available?: unknown }).available !== 'boolean')
    return unusable('eas-unavailable', 'eas simulator:availability printed no availability');
  return (data as { available: boolean }).available
    ? { usable: true }
    : unusable('eas-not-enabled', 'EAS Simulator is not enabled for this EAS account');
}

/**
 * Whether this run could use an EAS Simulator the way `--remote eas` does, without starting a session or a build.
 * Each refusal names what `--remote eas` would refuse later, so automatic placement falls through instead.
 */
export async function checkEasFallback({
  root,
  platform,
  slot,
  release,
  isExpo,
  tunnelMode,
  publicUrl,
  deviceTypeFlag,
  localOnlyFlags,
  env = process.env,
  resolveBin = resolveEasCliBin,
  readVersion = readInstalledEasCliVersion,
  onPath = (bin: string) => getExecutor().findExecutable(bin) !== null,
  readTunnel = readMetroTunnel,
  readSession = readRemoteSession,
  metroPort = () => getProject(root)?.metroPort ?? null,
  availability = async (bin: string) => {
    try {
      return {
        stdout: await getExecutor().runFileAsync(bin, ['simulator:availability', '--json', '--non-interactive'], {
          cwd: root,
          timeoutMs: AVAILABILITY_TIMEOUT_MS,
        }),
      };
    } catch (error) {
      const err = error as { stderr?: unknown; message?: unknown; code?: unknown };
      return {
        failure: String(err.stderr || err.message || error),
        timedOut: err.code === 'ETIMEDOUT',
      };
    }
  },
}: {
  root: string;
  platform: 'ios' | 'android';
  slot: string;
  release: boolean;
  isExpo: boolean;
  tunnelMode: TunnelMode | null;
  publicUrl: string | null;
  deviceTypeFlag?: string;
  /** Flags that pick a local simulator or emulator, which the eas backend refuses. */
  localOnlyFlags: string[];
  env?: NodeJS.ProcessEnv;
  resolveBin?: typeof resolveEasCliBin;
  readVersion?: typeof readInstalledEasCliVersion;
  onPath?: (bin: string) => boolean;
  readTunnel?: typeof readMetroTunnel;
  readSession?: typeof readRemoteSession;
  metroPort?: () => number | null;
  availability?: (bin: string) => Promise<{ stdout: string } | { failure: string; timedOut?: boolean }>;
}): Promise<EasFallbackCheck> {
  if (slot !== 'default')
    return unusable('eas-named-slot', `an EAS Simulator takes only the default slot, not ${slot}`);
  if (localOnlyFlags.length)
    return unusable('eas-local-flags', `${localOnlyFlags.join(' and ')} applies only to a ${platform} device on a Mac`);
  const session = readSession(root);
  if (session && session.platform !== platform)
    return unusable(
      'eas-session-busy',
      `this workspace's EAS Simulator session ${session.sessionId} runs ${session.platform ?? 'another platform'}`,
    );
  if (session && deviceTypeFlag?.trim() && session.deviceType !== deviceTypeFlag.trim())
    return unusable(
      'eas-session-busy',
      `this workspace's EAS Simulator session ${session.sessionId} runs ${session.deviceType ?? 'the model EAS chose'}, not ${deviceTypeFlag.trim()}`,
    );
  if (!onPath('agent-device')) return unusable('eas-no-agent-device', 'agent-device is not on PATH');
  const bin = resolveBin(root);
  if (!bin) return unusable('eas-no-cli', 'eas-cli is not installed for this project or on PATH');
  const versionOutput = readVersion(bin.file, root);
  const minimum =
    platform === 'ios' && deviceTypeFlag?.trim() ? MIN_EAS_CLI_DEVICE_VERSION : MIN_EAS_CLI_SIMULATOR_VERSION;
  const { supported, version } = easCliSupport(versionOutput, minimum);
  if (!supported)
    return unusable('eas-cli-too-old', `eas-cli ${version ?? '(unknown version)'} is older than ${minimum}`);
  if (!release) {
    const mode = tunnelMode ?? 'auto';
    if (mode === 'off')
      return unusable('eas-metro-unreachable', 'metro.tunnel is off, so an EAS Simulator cannot reach Metro');
    const plan = planMetroReach({
      mode,
      metroPort: metroPort() ?? 'unknown',
      publicUrl: env[PUBLIC_METRO_ENV]?.trim() || publicUrl,
      isExpo,
      available: detectProviders(onPath, mode),
    });
    if ('failed' in plan) return unusable('eas-metro-unreachable', plan.failed);
    if ('start' in plan && plan.start === 'tailscale')
      return unusable('eas-metro-unreachable', 'metro.tunnel is tailscale, which an EAS Simulator cannot reach');
    if ('expoTunnel' in plan && readTunnel(root)?.kind !== 'expo')
      return unusable('eas-metro-unreachable', 'Metro has no Expo tunnel; run stim start --remote first');
  }
  return parseSimulatorAvailability(await availability(bin.file));
}
