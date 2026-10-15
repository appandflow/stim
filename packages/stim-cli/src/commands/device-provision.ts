import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
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
  readInstalledProfiles,
  runProvisioningBuild,
  signingTargetsRefusal,
  type ProvisionChanges,
  type ProvisionRefusal,
} from '../engine/ios-provision.ts';
import { listIosDevices, resolveIosPhysicalDevice } from '../engine/ios-device.ts';
import { findSigningIdentities } from '../engine/ios-signing.ts';
import { resolveScheme, type XcodeProject } from '../engine/xcode.ts';
import { discoverXcodeProject } from '../integrations/react-native-build.ts';
import { makeTemporaryDirectory, removeTemporaryEntry } from '../temporary.ts';
import { resolveIosProjectDir, resolveProjectSettings } from '../workspace/settings.ts';
import { findProjectRoot, NO_PROJECT_REFUSAL } from '../workspace/project.ts';
import { resolveConfiguration, resolveSchemeSelection } from './ios/support.ts';

export interface ProvisionOptions {
  scheme?: string;
  configuration?: string;
  yes?: boolean;
  json?: boolean;
}

export interface ProvisionDeps {
  findProjectRoot: typeof findProjectRoot;
  resolveSettings: (root: string) => SettingsObject;
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
  listIosDevices: typeof listIosDevices;
  discoverXcodeProject: typeof discoverXcodeProject;
  resolveScheme: typeof resolveScheme;
  readBuildSettings: (project: XcodeProject, scheme: string, configuration: string) => Promise<string | null>;
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  profileFiles: typeof listProfileFiles;
  readInstalledProfiles: typeof readInstalledProfiles;
  findSigningIdentities: typeof findSigningIdentities;
  runProvisioningBuild: typeof runProvisioningBuild;
  makeDerivedData: (root: string) => string;
  removeDerivedData: (path: string) => void;
  now: () => number;
  out: (line: string) => void;
  note: (line: string) => void;
}

async function readBuildSettings(project: XcodeProject, scheme: string, configuration: string): Promise<string | null> {
  try {
    return await getExecutor().runFileAsync(
      'xcodebuild',
      [
        project.flag as string,
        project.path as string,
        '-scheme',
        scheme,
        '-configuration',
        configuration,
        '-sdk',
        'iphoneos',
        '-destination',
        'generic/platform=iOS',
        '-showBuildSettings',
        '-json',
      ],
      { cwd: project.dir as string, timeoutMs: 180_000 },
    );
  } catch {
    return null;
  }
}

async function confirmInTerminal(question: string): Promise<boolean> {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await input.question(question)).trim());
  } finally {
    input.close();
  }
}

const DEFAULT_DEPS: ProvisionDeps = {
  findProjectRoot,
  resolveSettings: (root) => resolveProjectSettings(root).settings,
  env: process.env,
  fileExists: existsSync,
  listIosDevices,
  discoverXcodeProject,
  resolveScheme,
  readBuildSettings,
  interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
  confirm: confirmInTerminal,
  profileFiles: listProfileFiles,
  readInstalledProfiles,
  findSigningIdentities,
  runProvisioningBuild,
  makeDerivedData: (root) => makeTemporaryDirectory(root, 'stim-provision-'),
  removeDerivedData: removeTemporaryEntry,
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
  targets: Array<{ target: string; bundleId: string }>;
}

export interface ProvisionFailure extends ProvisionRefusal {
  plan?: ProvisionPlan;
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

  const auth = provisionAuth(settings, d.env, d.fileExists);
  if ('code' in auth) return report(auth);

  const resolved = resolveIosPhysicalDevice(udidArg ?? null, await d.listIosDevices());
  if (!resolved.udid) {
    return report({ code: 'STIM_NO_DEVICE', message: resolved.error as string, remedy: resolved.remedy ?? '' });
  }
  const device = { udid: resolved.udid, name: resolved.name ?? resolved.udid };

  const project = d.discoverXcodeProject(root, resolveIosProjectDir(settings, root).dir);
  if (project.error) {
    return report({
      code: 'STIM_PROVISION_FAILED',
      message: project.error.message,
      remedy: project.error.remedy ?? '',
    });
  }
  const selected = await d.resolveScheme(project, {
    scheme: resolveSchemeSelection({ scheme: opts.scheme ?? null }, settings) ?? null,
  });
  if (selected.error) return report(selected.error);
  const scheme = selected.scheme as string;
  const configuration = resolveConfiguration(opts.configuration, settings) ?? 'Debug';

  const buildSettings = await d.readBuildSettings(project, scheme, configuration);
  if (buildSettings === null) {
    return report({
      code: 'STIM_PROVISION_FAILED',
      message: `xcodebuild could not report the ${configuration} build settings of scheme ${scheme} in ${project.path}.`,
      remedy: `Run \`xcodebuild ${project.flag} ${project.path} -scheme ${scheme} -configuration ${configuration} -sdk iphoneos -showBuildSettings\` to see what it reports.`,
    });
  }
  const targets = parseSigningTargets(buildSettings);
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
    targets: targets.map(({ target, bundleId }) => ({ target, bundleId })),
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

  const dirs = profileDirectories();
  const profilesBefore = d.profileFiles(dirs);
  const identitiesBefore = await d.findSigningIdentities();
  d.note(chalk.dim(`Provisioning through ${describeAuth(auth)}; xcodebuild contacts Apple...`));
  const derivedDataPath = d.makeDerivedData(root);
  let run;
  try {
    run = await d.runProvisioningBuild({
      args: provisionXcodebuildArgs({ project, scheme, configuration, udid: device.udid, derivedDataPath, auth }),
      cwd: project.dir as string,
      env: d.env,
    });
  } finally {
    try {
      d.removeDerivedData(derivedDataPath);
    } catch {}
  }
  if (run.error) {
    return report({
      code: 'STIM_PROVISION_FAILED',
      message: `Could not run xcodebuild: ${run.error.message}`,
      remedy: 'Install Xcode and select it with `sudo xcode-select -s /Applications/Xcode.app`.',
      plan,
    });
  }
  if (!run.resolved) return report({ ...provisionFailure(run.lines, auth, teams.join(', ')), plan });

  const changes = provisionChanges({
    before: profilesBefore,
    after: await d.readInstalledProfiles(d.profileFiles(dirs)),
    targets,
    udid: device.udid,
    identitiesBefore,
    identitiesAfter: await d.findSigningIdentities(),
    now: d.now(),
  });
  const result: ProvisionResult = { ...plan, changes };
  if (json) {
    d.out(JSON.stringify(result));
  } else {
    d.out(chalk.green(`Provisioned signing for ${device.name} (${device.udid}) on team ${teams.join(', ')}.`));
    for (const line of provisionReportLines(changes, device)) d.out(line);
    d.out(`Next: stim ios --device ${device.udid}`);
  }
  return result;
}
