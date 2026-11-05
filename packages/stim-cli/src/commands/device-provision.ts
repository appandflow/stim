import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import type { StimContext } from '@stim-cli/core';
import type { SettingsObject } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import {
  describeAuth,
  listProfileFiles,
  parseSigningTargets,
  profileDirectories,
  provisionAuth,
  provisionChanges,
  provisionFailure,
  provisionPlanLines,
  provisionReportLines,
  provisionXcodebuildArgs,
  PROVISION_TIMEOUT_MS,
  readInstalledProfiles,
  redactKeyPath,
  runProvisioningBuild,
  signingTargetsRefusal,
  type ProvisionChanges,
  type ProvisionRefusal,
} from '../engine/ios-provision.ts';
import { listIosDevices, resolveIosPhysicalDevice } from '../engine/ios-device.ts';
import { findSigningIdentities } from '../engine/ios-signing.ts';
import { operationState } from '../engine/operation-state.ts';
import { resolveScheme, type XcodeProject } from '../engine/xcode.ts';
import { nativeXcodeHasPackages, nativeXcodePackages } from '../integrations/native-xcode-inputs.ts';
import { NativeXcodeError, selectNativeXcodeProject } from '../integrations/native-xcode-project.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { discoverXcodeProject } from '../integrations/react-native-build.ts';
import { makeTemporaryDirectory, removeTemporaryEntry } from '../temporary.ts';
import { resolveIosProjectDir, resolveProjectSettings } from '../workspace/settings.ts';
import { loadConfig } from '../workspace/config.ts';
import { findProjectRoot, NO_PROJECT_REFUSAL } from '../workspace/project.ts';
import { resolveConfiguration, resolveSchemeSelection } from './ios/support.ts';

export interface ProvisionOptions {
  scheme?: string;
  configuration?: string;
  yes?: boolean;
  json?: boolean;
}

interface XcodeSelection {
  project: XcodeProject & { flag: string; path: string; dir: string };
  scheme: string;
  configuration: string;
  packageArgs: string[];
}

export interface ProvisionDeps {
  findProjectRoot: typeof findProjectRoot;
  resolveSettings: (root: string) => SettingsObject;
  machineConfig: () => unknown;
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
  listIosDevices: typeof listIosDevices;
  selectXcode: (
    root: string,
    settings: SettingsObject,
    selectors: { scheme: string | null; configuration: string },
  ) => Promise<XcodeSelection | ProvisionRefusal>;
  readBuildSettings: (selection: XcodeSelection) => Promise<{ output: string } | { error: string }>;
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  profileFiles: typeof listProfileFiles;
  readInstalledProfiles: typeof readInstalledProfiles;
  findSigningIdentities: typeof findSigningIdentities;
  runProvisioningBuild: typeof runProvisioningBuild;
  makeDerivedData: (root: string) => string;
  removeDerivedData: (path: string) => void;
  operation: StimContext | undefined;
  now: () => number;
  out: (line: string) => void;
  note: (line: string) => void;
}

function located(project: XcodeProject): XcodeSelection['project'] | null {
  const { flag, path, dir } = project;
  return flag && path && dir ? { ...project, flag, path, dir } : null;
}

async function selectXcode(
  root: string,
  settings: SettingsObject,
  { scheme, configuration }: { scheme: string | null; configuration: string },
): Promise<XcodeSelection | ProvisionRefusal> {
  const selected = projectRegistry.selectIos(root);
  if ('problem' in selected) {
    return { code: 'STIM_NO_PROJECT', message: selected.problem.message, remedy: selected.problem.remedy };
  }
  if (selected.id === 'native-xcode') {
    try {
      const native = selectNativeXcodeProject(root, scheme ?? undefined, configuration);
      const packages = nativeXcodePackages(root);
      if (nativeXcodeHasPackages(native) && !existsSync(join(packages, 'workspace-state.json'))) {
        return {
          code: 'STIM_PROVISION_FAILED',
          message: existsSync(packages)
            ? `Scheme ${native.scheme} uses Swift packages, and Stim's package directory ${packages} holds no workspace-state.json, so its resolution is incomplete.`
            : `Scheme ${native.scheme} uses Swift packages, and this workspace has not resolved them yet.`,
          remedy:
            "Run `stim ios` once (it resolves them into Stim's package directory for a simulator build), or `stim ios --device <udid>` (it resolves them and stops at signing), then run `stim device provision ios` again.",
        };
      }
      return {
        project: native.container,
        scheme: native.scheme,
        configuration,
        packageArgs: nativeXcodeHasPackages(native)
          ? ['-clonedSourcePackagesDirPath', packages, '-disableAutomaticPackageResolution']
          : [],
      };
    } catch (error) {
      if (error instanceof NativeXcodeError) return { code: error.code, message: error.message, remedy: error.remedy };
      throw error;
    }
  }
  const discovered = discoverXcodeProject(root, resolveIosProjectDir(settings, root).dir);
  const project = located(discovered);
  if (discovered.error || !project) {
    return {
      code: 'STIM_PROVISION_FAILED',
      message: discovered.error?.message ?? `No Xcode project or workspace was found for ${root}.`,
      remedy: discovered.error?.remedy ?? 'Generate the ios/ project, then retry.',
    };
  }
  const resolved = await resolveScheme(project, { scheme });
  if (resolved.error || !resolved.scheme) {
    return (
      resolved.error ?? {
        code: 'STIM_NO_SCHEME',
        message: `Could not select an app scheme in ${project.path}.`,
        remedy: 'Pass --scheme <name>, or set ios.scheme.',
      }
    );
  }
  return { project, scheme: resolved.scheme, configuration, packageArgs: [] };
}

function lastLines(text: string, count = 5): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' | ');
}

function errorField(error: unknown, key: string): string {
  return error && typeof error === 'object' && key in error ? String(Reflect.get(error, key) ?? '') : '';
}

async function readBuildSettings({
  project,
  scheme,
  configuration,
  packageArgs,
}: XcodeSelection): Promise<{ output: string } | { error: string }> {
  try {
    return {
      output: await getExecutor().runFileAsync(
        'xcodebuild',
        [
          project.flag,
          project.path,
          '-scheme',
          scheme,
          '-configuration',
          configuration,
          '-sdk',
          'iphoneos',
          '-destination',
          'generic/platform=iOS',
          ...packageArgs,
          '-showBuildSettings',
          '-json',
        ],
        { cwd: project.dir, timeoutMs: 180_000 },
      ),
    };
  } catch (error) {
    return {
      error: lastLines(
        errorField(error, 'stderr') || errorField(error, 'stdout') || errorField(error, 'message') || String(error),
      ),
    };
  }
}

interface Prompt {
  question(query: string, options: { signal: AbortSignal }): Promise<string>;
  on(event: 'SIGINT' | 'close', listener: () => void): unknown;
  off(event: 'SIGINT' | 'close', listener: () => void): unknown;
  close(): void;
}

function openTerminal(): Prompt {
  return createInterface({ input: process.stdin, output: process.stderr });
}

/** Asks `question` on the terminal; only `y` or `yes` confirms, and Ctrl+C or end of input answer no. */
export async function confirmInTerminal(question: string, open: () => Prompt = openTerminal): Promise<boolean> {
  const input = open();
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.on('SIGINT', abort);
  input.on('close', abort);
  try {
    return /^(y|yes)$/i.test((await input.question(question, { signal: controller.signal })).trim());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return false;
    throw error;
  } finally {
    input.off('SIGINT', abort);
    input.off('close', abort);
    input.close();
  }
}

const DEFAULT_DEPS: ProvisionDeps = {
  findProjectRoot,
  resolveSettings: (root) => resolveProjectSettings(root).settings,
  machineConfig: loadConfig,
  env: process.env,
  fileExists: existsSync,
  listIosDevices,
  selectXcode,
  readBuildSettings,
  interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
  confirm: (question) => confirmInTerminal(question),
  profileFiles: listProfileFiles,
  readInstalledProfiles,
  findSigningIdentities,
  runProvisioningBuild,
  makeDerivedData: (root) => makeTemporaryDirectory(root, 'stim-provision-'),
  removeDerivedData: removeTemporaryEntry,
  operation: undefined,
  now: () => Date.now(),
  out: (line) => console.log(line),
  note: (line) => console.error(line),
};

interface ProvisionPlan {
  platform: 'ios';
  udid: string;
  deviceName: string;
  teams: string[];
  auth: { kind: 'xcode-account' } | { kind: 'api-key'; keyId: string };
  scheme: string;
  configuration: string;
  targets: Array<{ target: string; bundleId: string; platform: string }>;
}

export interface ProvisionFailure extends ProvisionRefusal {
  plan?: ProvisionPlan;
  changes?: ProvisionChanges;
}

export interface ProvisionResult extends ProvisionPlan {
  changes: ProvisionChanges;
}

const UNCONFIRMED_REMEDY =
  'Run it in a terminal and answer y, or pass --yes once the owner of the Apple Developer account has agreed to the changes listed. Agents never pass --yes without the user explicitly asking for this step.';

export async function runProvision(
  platformArg: string,
  udidArg: string | undefined,
  opts: ProvisionOptions = {},
  overrides: Partial<ProvisionDeps> = {},
): Promise<ProvisionResult | ProvisionFailure> {
  const d: ProvisionDeps = { ...DEFAULT_DEPS, ...overrides };
  const json = Boolean(opts.json);
  const report = (failure: ProvisionFailure): ProvisionFailure => {
    d.note(chalk.red(`${failure.code}: ${failure.message}`));
    d.note(chalk.dim(failure.remedy));
    if (json) {
      d.out(
        JSON.stringify({
          code: failure.code,
          message: failure.message,
          remedy: failure.remedy,
          ...(failure.plan ? { plan: failure.plan } : {}),
          ...(failure.changes ? { changes: failure.changes } : {}),
        }),
      );
    }
    return failure;
  };

  if (platformArg !== 'ios') {
    return report({
      code: 'STIM_BAD_ARG',
      message: `\`stim device provision\` takes ios, not ${JSON.stringify(platformArg)}.`,
      remedy:
        'Run `stim device provision ios`. Android debug builds install on a phone without any developer account change.',
    });
  }

  const root = d.findProjectRoot(process.cwd());
  if (!root) return report(NO_PROJECT_REFUSAL);
  const settings = d.resolveSettings(root);

  const auth = provisionAuth(d.machineConfig(), d.env, d.fileExists);
  if ('code' in auth) return report(auth);

  const resolved = resolveIosPhysicalDevice(udidArg ?? null, await d.listIosDevices(), {
    several: 'Name the one to provision with `stim device provision ios <udid>`.',
    notAPhone:
      'Name a physical iPhone or iPad from `xcrun devicectl list devices` with `stim device provision ios <udid>`. Simulators need no provisioning.',
    physicalOnly: '`stim device provision ios` provisions only a physical iPhone or iPad',
    transportOnly: 'Stim provisions a phone only over a cable or Wi-Fi',
  });
  if (!resolved.udid) {
    return report({ code: 'STIM_NO_DEVICE', message: String(resolved.error), remedy: resolved.remedy ?? '' });
  }
  const device = { udid: resolved.udid, name: resolved.name ?? resolved.udid };

  const selection = await d.selectXcode(root, settings, {
    scheme: resolveSchemeSelection({ scheme: opts.scheme ?? null }, settings) ?? null,
    configuration: resolveConfiguration(opts.configuration, settings) ?? 'Debug',
  });
  if ('code' in selection) return report(selection);
  const { project, scheme, configuration } = selection;

  const buildSettings = await d.readBuildSettings(selection);
  const targets = 'output' in buildSettings ? parseSigningTargets(buildSettings.output) : null;
  if (!targets) {
    return report({
      code: 'STIM_PROVISION_FAILED',
      message:
        'error' in buildSettings
          ? `xcodebuild could not report the ${configuration} build settings of scheme ${scheme}: ${buildSettings.error}`
          : `xcodebuild reported the ${configuration} build settings of scheme ${scheme}, but not as JSON Stim can read.`,
      remedy: `Run \`xcodebuild ${project.flag} ${project.path} -scheme ${scheme} -configuration ${configuration} -sdk iphoneos -showBuildSettings -json\` to see what it reports.`,
    });
  }
  const targetRefusal = signingTargetsRefusal(targets, { scheme, configuration });
  if (targetRefusal) return report(targetRefusal);

  const teams = [...new Set(targets.flatMap((target) => (target.team ? [target.team] : [])))];
  const plan: ProvisionPlan = {
    platform: 'ios',
    udid: device.udid,
    deviceName: device.name,
    teams,
    auth: auth.kind === 'api-key' ? { kind: 'api-key', keyId: auth.keyId } : { kind: 'xcode-account' },
    scheme,
    configuration,
    targets: targets.map(({ target, bundleId, platform }) => ({ target, bundleId, platform })),
  };
  for (const line of provisionPlanLines({ device, targets, auth, scheme, configuration })) d.note(line);

  const confirmed =
    opts.yes === true ||
    (!json && d.interactive && (await d.confirm('Make these changes to the Apple Developer account? [y/N] ')));
  if (!confirmed) {
    return report({
      code: 'STIM_PROVISION_UNCONFIRMED',
      message:
        'Nothing changed: provisioning changes an Apple Developer account, so it runs only after explicit confirmation.',
      remedy: UNCONFIRMED_REMEDY,
      plan,
    });
  }

  let derivedDataPath: string;
  try {
    derivedDataPath = d.makeDerivedData(root);
  } catch (error) {
    return report({
      code: 'STIM_PROVISION_FAILED',
      message: `Nothing changed: Stim could not create a temporary DerivedData directory: ${error instanceof Error ? error.message : String(error)}`,
      remedy:
        'Set STIM_TMPDIR, or tempDir in the Stim machine config, to a writable directory outside Git working trees.',
      plan,
    });
  }
  const removeDerivedData = () => {
    try {
      d.removeDerivedData(derivedDataPath);
    } catch {}
  };
  const state = operationState(d.operation);
  const drain = () => {
    state.handled = true;
    state.draining = true;
  };
  d.operation?.signal.addEventListener('abort', drain, { once: true });
  let running: { kill(signal: NodeJS.Signals): boolean } | null = null;
  const forcedExit = () => {
    running?.kill('SIGKILL');
    removeDerivedData();
  };
  state.exitCleanups.add(forcedExit);

  const dirs = profileDirectories();
  const profilesBefore = d.profileFiles(dirs);
  const identitiesBefore = await d.findSigningIdentities();
  d.note(chalk.dim(`Provisioning through ${describeAuth(auth)}; xcodebuild contacts Apple...`));
  let run;
  try {
    if (d.operation?.signal.aborted) {
      return report({
        code: 'STIM_PROVISION_FAILED',
        message: 'Nothing changed: provisioning was interrupted before xcodebuild started.',
        remedy: 'Run `stim device provision ios` again.',
        plan,
      });
    }
    run = await d.runProvisioningBuild({
      args: provisionXcodebuildArgs({
        project,
        scheme,
        configuration,
        udid: device.udid,
        derivedDataPath,
        auth,
        packageArgs: selection.packageArgs,
      }),
      cwd: project.dir,
      env: d.env,
      ...(d.operation ? { signal: d.operation.signal } : {}),
      onChild: (child) => {
        running = child;
        return () => {
          running = null;
        };
      },
    });
  } finally {
    removeDerivedData();
    state.exitCleanups.delete(forcedExit);
    d.operation?.signal.removeEventListener('abort', drain);
  }

  const changes = provisionChanges({
    before: profilesBefore,
    after: await d.readInstalledProfiles(d.profileFiles(dirs)),
    targets,
    udid: device.udid,
    identitiesBefore,
    identitiesAfter: await d.findSigningIdentities(),
    now: d.now(),
  });

  if (!run.resolved) {
    const failure = run.error
      ? {
          code: 'STIM_PROVISION_FAILED',
          message: `Could not run xcodebuild: ${redactKeyPath(run.error.message, auth)}`,
          remedy: 'Install Xcode and select it with `sudo xcode-select -s /Applications/Xcode.app`.',
        }
      : run.cancelled
        ? {
            code: 'STIM_PROVISION_FAILED',
            message: 'Provisioning was interrupted before xcodebuild resolved signing.',
            remedy: 'Run `stim device provision ios` again to finish; it is safe to repeat.',
          }
        : run.timedOut
          ? {
              code: 'STIM_PROVISION_FAILED',
              message: `xcodebuild did not resolve signing within ${PROVISION_TIMEOUT_MS / 60_000} minutes, so Stim stopped it.`,
              remedy:
                'Check the network connection to Apple and that the phone stays unlocked and connected, then run `stim device provision ios` again.',
            }
          : provisionFailure(run.lines, auth, teams.join(', '));
    const already = provisionReportLines(changes, device, false);
    if (already.length > 0 && !json) {
      d.note('Already changed before it stopped:');
      for (const line of already) d.note(`  ${redactKeyPath(line, auth)}`);
    }
    return report({ ...failure, plan, changes });
  }

  const result: ProvisionResult = { ...plan, changes };
  if (json) {
    d.out(JSON.stringify(result));
  } else {
    const unconfirmed = changes.profiles.some((outcome) => outcome.onPhone && outcome.profile === null);
    d.out(
      unconfirmed
        ? chalk.yellow(
            `xcodebuild resolved signing for ${device.name} (${device.udid}) on team ${teams.join(', ')}, but Stim could not confirm every installed profile.`,
          )
        : chalk.green(`Provisioned signing for ${device.name} (${device.udid}) on team ${teams.join(', ')}.`),
    );
    for (const line of provisionReportLines(changes, device)) d.out(unconfirmed ? chalk.yellow(line) : line);
    d.out(`Next: stim ios --device ${device.udid}`);
  }
  return result;
}
