import { ambientContext, ambientEnv } from '@stim-cli/core';
import { operationState } from './engine/operation-state.ts';
import { InvalidArgumentError } from 'commander';
import { parseMachine, automaticMachineEnabled, placementWord, readBuildMachines } from '@stim-cli/core/state';
import type { PlacementSetting, SettingSource } from './placement-log.ts';
import { loadConfig } from './workspace/config.ts';
import { POD_MISSING_REASON } from './engine/deps.ts';
import { cocoapodsInstall } from './engine/toolchain.ts';

const FINGERPRINT_MISMATCH_REMEDY =
  "The build Mac fingerprints the synced checkout differently; the message names the sources that differ. Stim sends tracked and untracked files and the gitignored files the fingerprint reads, except under node_modules. A source still differs when the build Mac's dependency install or pod install writes it differently, or when the app config reads an environment variable or file that differs. Make that input agree on both Macs, for example by committing the lockfile pod install rewrote there, or rerun with --remote-build auto or --remote-build local.";

/** The remedy for a React Native worker's fingerprint-mismatch reason, or undefined for any other reason. */
export function fingerprintMismatchRemedy(reason: string): string | undefined {
  return reason.startsWith('fingerprint-mismatch: the checkout there ') ? FINGERPRINT_MISMATCH_REMEDY : undefined;
}

const MISSING_PACKAGE_MANAGER = /^deps-failed: spawn (pnpm|yarn|npm) ENOENT/;

/** The remedy for a worker whose dependency install could not start its package manager; undefined for any other reason. */
export function missingPackageManagerRemedy(machine: string, reason: string): string | undefined {
  const tool = MISSING_PACKAGE_MANAGER.exec(reason)?.[1];
  if (!tool) return undefined;
  const install =
    tool === 'npm'
      ? 'Reinstall Node there, which ships npm'
      : `Install it with \`corepack enable ${tool}\` or \`npm install --global ${tool}\`, using sudo where Node is installed system-wide`;
  return `${machine} has no ${tool} on the PATH of its stim service, and the app's lockfile needs it. ${install}, then run the same command again, or rerun with --remote-build auto or --remote-build local.`;
}

export const HOLDS_SIGNING_FILE = 'holds an Android signing key or its password';
const SIGNING_FAILURE = /\bsign(?:ing|ed)?\b|keystore|store_?file/i;

/** The remedy for an offloaded release build stopped by signing material that stays on this machine; undefined for any other reason. */
export function androidReleaseRemedy(reason: string): string | undefined {
  if (reason.includes(HOLDS_SIGNING_FILE))
    return 'Remove that key or password from the repository, or build here with --remote-build local.';
  return SIGNING_FAILURE.test(reason)
    ? "A remote machine gets no signing key or password from this one, so it builds a project's real release signing as an unsigned APK and this machine signs it. If the build failed there, the project's Gradle scripts read the key or password while configuring: guard those reads with hasProperty or a file check, or build here with --remote-build local. If the APK could not be signed here, install the Android SDK build-tools, and set android.keystore or keep android/app/debug.keystore."
    : undefined;
}

const PODS_FAILED_PREFIX = 'pod install failed: ';

/** The reason a failed worker job is reported with: a `pods-failed` code reads as a failed pod install. */
export function workerFailureReason(code: unknown, message: unknown): string {
  return code === 'pods-failed'
    ? `${PODS_FAILED_PREFIX}${String(message ?? '')}`
    : `${String(code ?? 'failed')}: ${String(message ?? '')}`;
}

/** The remedy for a worker whose `pod install` failed, naming the install when it has no CocoaPods; undefined for any other reason. */
export function podsFailedRemedy(machine: string, reason: string, localCocoapods: string | null): string | undefined {
  if (!reason.startsWith(PODS_FAILED_PREFIX)) return undefined;
  const retry = 'run the same command again, or rerun with --remote-build auto or --remote-build local';
  if (!reason.includes(POD_MISSING_REASON)) {
    return `Fix the pod install error on ${machine} (run pod install in its checkout under server.workerRoot there to see all of it), then ${retry}.`;
  }
  const { lead, commands } = cocoapodsInstall(localCocoapods);
  return [`On ${machine}, ${lead}:`, ...commands, `Then ${retry}.`].join('\n');
}

export class OffloadRefusal extends Error {
  readonly code = 'STIM_OFFLOAD_REFUSED';
  readonly remedy: string;

  constructor(
    machine: string,
    reason: string,
    remedy = 'Run stim doctor --fix to ask for build access if not paired; it prints the stim setup command a person runs on the worker to approve this machine. Check stim settings get remote.machines, or rerun with --remote-build auto, remote or local.',
  ) {
    super(reason.startsWith(`${machine}: `) ? reason : `${machine}: ${reason}`);
    this.remedy = remedy;
  }
}

export function resolveBuildMachine(flag?: string, env?: string, setting?: unknown): string {
  const selected = flag ?? (env?.trim() || undefined) ?? setting ?? 'auto';
  if (typeof selected !== 'string' || !selected.trim() || !parseMachine(selected)) {
    throw Object.assign(
      new Error('--remote-build / remote.build must be local, auto, remote, remote-only, or a tailnet machine name.'),
      { code: 'STIM_BAD_ARG' },
    );
  }
  return placementWord(selected) ?? selected.trim();
}

export function parseBuildMachineOption(value: string): string {
  try {
    return resolveBuildMachine(value);
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
}

export function automaticBuild(selected: string): boolean {
  const word = placementWord(selected);
  return word !== null && word !== 'local';
}

export function requireLocalBuild(selected: string, reason?: string): void {
  const word = placementWord(selected);
  const lead = reason ? `${reason}; ` : '';
  if (word === 'remote-only') throw new OffloadRefusal(selected, `${lead}remote-only never builds on this machine`);
  if ((word === 'auto' || word === 'remote') && !automaticMachineEnabled('build', 'local'))
    throw new OffloadRefusal(
      selected,
      `${lead}local is disabled in remote.buildPoolDisabled; enable it or select a machine explicitly`,
    );
}

export function namedBuildMachine(selected: string): boolean {
  return placementWord(selected) === null;
}

export function requireConfiguredMachine(selected: string, machines: unknown): string {
  if (!namedBuildMachine(selected)) return selected;
  const parsed = parseMachine(selected)!;
  const entries = Array.isArray(machines) ? machines.filter((entry): entry is string => typeof entry === 'string') : [];
  const match = entries.find((entry) => {
    const candidate = parseMachine(entry);
    return (
      candidate?.transport === parsed.transport && candidate.name === parsed.name && candidate.port === parsed.port
    );
  });
  if (!match)
    throw new OffloadRefusal(selected, `not listed in remote.machines (configured: ${entries.join(', ') || 'none'})`);
  return match;
}

const settingSource = (flag: string | undefined, env: string | undefined, setting: unknown): SettingSource =>
  flag !== undefined ? 'flag' : env?.trim() ? 'env' : setting !== undefined ? 'setting' : 'default';

/** The settings that decide where a build runs, with the layer each value came from, for this run's `--remote-build`. */
export function buildPlacementSettings(selected: string): PlacementSetting[] {
  const flag = operationState(ambientContext()).buildMachineFlag;
  return [
    {
      key: 'remote.build',
      value: selected,
      from: settingSource(flag, ambientEnv().STIM_REMOTE_BUILD, loadConfig()?.remote?.build),
    },
  ];
}

export function resolveBuildPlacement(flag?: string): {
  selected: string;
  failure?: { code: string; message: string; remedy: string };
} {
  const remote = loadConfig()?.remote;
  operationState(ambientContext()).buildMachineFlag = flag;
  let selected = 'auto';
  try {
    selected = resolveBuildMachine(flag, ambientEnv().STIM_REMOTE_BUILD, remote?.build);
    selected = requireConfiguredMachine(selected, remote?.machines);
    if (
      namedBuildMachine(selected) &&
      !readBuildMachines().some((each) => each.state === 'approved' && each.machine === selected)
    )
      throw new OffloadRefusal(selected, 'no remote machine is paired');
    return { selected };
  } catch (error) {
    return {
      selected,
      failure: {
        code: (error as { code: string }).code,
        message: (error as Error).message,
        remedy:
          error instanceof OffloadRefusal
            ? error.remedy
            : 'Pass --remote-build local, auto, remote, remote-only, or an entry from stim settings get remote.machines.',
      },
    };
  }
}
