import { maintenanceNdjsonFile } from '@stim-cli/core/state';
import { discoverToolchain, projectNodeBin, projectNodePin, type ToolchainEntry } from '@stim-cli/core/toolchain';
import { maintenanceStatus, maintenanceLine } from '../maintenance/status.ts';
import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { recordDoctorRun } from '../guide-status.ts';
import { projectRegistry } from '../integrations/projects.ts';
import type { ProjectRegistry } from '../integrations/project-registry.ts';
import type { ProjectDoctor } from '../integrations/project-doctor.ts';
import { getProject } from '../workspace/config.ts';
import {
  projectSettingsContextAsync,
  type ProjectSettingsContext,
  type SettingsObject,
} from '../workspace/settings.ts';
import type { StimContext } from '@stim-cli/core';
import { readMachineSettings, type MachineSettings } from '../diagnostics/doctor-config.ts';
import { checkWorktreeStorageLayout } from '../diagnostics/doctor-storage.ts';
import {
  iosRuntimeMatches,
  listAllIosSimsAsync,
  listIosRuntimesAsync,
  pickDefaultIosCreation,
} from '../devices/ios.ts';
import { offloadCheck } from '../offload/client.ts';
import { resolveDeviceType, resolveRuntime } from './ios/support.ts';
import {
  allowanceSearchPaths,
  applyClaudeAllowance,
  claudeLocalSettingsPath,
  detectHarness,
  missingAllowance,
  sandboxAllowance,
  sandboxFinding,
} from '../diagnostics/sandbox.ts';
import { runDoctor } from '../diagnostics/doctor.ts';
import { detectXcodeMajorAsync } from '../engine/xcode.ts';
import type { DoctorPlatform, Finding } from '../diagnostics/doctor.ts';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { NO_PROJECT_REFUSAL } from '../workspace/project.ts';
import { compareStimVersions, inspectStimVersions, type StimVersionReport } from '../diagnostics/stim-installations.ts';
import { budgetLine, inspectBudget, type BudgetReport } from '../budget.ts';
import { inspectBuildMachines, type BuildMachinesInspection } from '../offload/build-machines.ts';
import { doctorIo, type GeneratedTickets } from '../offload/tailnet.ts';
import { inspectHostedAgentDriver } from '../device-host/agent-driver.ts';
import { inspectDeviceHostMachines } from '../device-host/machines.ts';
import { inspectWatchmanMemory, memorySweepIsScoped } from './gc/memory.ts';
import { memoryCulpritFindings, readMemoryCulpritsAsync } from '../memory-culprits.ts';
import {
  inspectNestedWorktrees,
  nestedWorktreeFinding,
  watchedCheckouts,
  writeIgnoreDirs,
} from '../diagnostics/doctor-watchman.ts';

interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  platform?: DoctorPlatform;
}

export function parseDoctorPlatform(value: string): DoctorPlatform {
  if (value === 'ios' || value === 'android') return value;
  throw new InvalidArgumentError('expected one of: ios, android');
}

/**
 * The simulator runtime `stim ios` would build for here: the one `ios.runtime` names, else the workspace's own
 * simulator's, else the one it would create a simulator on.
 */
async function iosTargetRuntime(root: string, settings: SettingsObject | null): Promise<string | null> {
  if (!settings) return null;
  try {
    const runtimes = await listIosRuntimesAsync();
    const runtime = resolveRuntime(null, settings);
    if (runtime) return runtimes.find((each) => iosRuntimeMatches(each, runtime))?.identifier ?? null;
    const udid = getProject(root)?.platforms?.ios?.deviceUdid;
    const own =
      typeof udid === 'string' ? (await listAllIosSimsAsync()).find((device) => device.udid === udid)?.runtime : null;
    if (own) return own;
    const deviceType = resolveDeviceType(null, settings) ?? undefined;
    return pickDefaultIosCreation([], runtimes, { deviceType })?.runtimeId ?? null;
  } catch {
    return null;
  }
}

function withoutUnhandledRejection<T>(started: Promise<T>): Promise<T> {
  started.catch(() => {});
  return started;
}

function doctorTarget(platform?: DoctorPlatform): string {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  return 'all platforms';
}

function stimVersionLines(report: StimVersionReport): string[] {
  const resolved = report.resolved
    ? `${report.resolved.version ?? 'unknown version'} at ${report.resolved.path}`
    : 'not found on PATH';
  const paths = `${report.installations.length} distinct PATH install${report.installations.length === 1 ? '' : 's'}`;
  const pathVersions = [...new Set(report.installations.map((entry) => entry.version).filter(Boolean))];
  const versions = pathVersions.length > 1 ? ` (${pathVersions.join(', ')})` : '';
  return [
    phaseLine('version', report.runningVersion),
    phaseLine('resolved', resolved),
    phaseLine('installs', paths + versions),
  ];
}

const OVERRIDES: Record<string, string> = {
  node: 'put another node first on PATH',
  JAVA_HOME: 'set JAVA_HOME',
  ANDROID_HOME: 'set ANDROID_HOME',
};

/**
 * Where the toolchain a process without a login shell, such as stim-server under Stim Desktop, finds each tool,
 * and the Node the project's dev server runs on.
 */
export interface ToolchainReport {
  entries: ToolchainEntry[];
  projectNode: {
    pin: string;
    spec: string;
    bin: string | null;
    version: string | null;
    match: 'exact' | 'major' | null;
  } | null;
}

export function toolchainReport(root: string, env: NodeJS.ProcessEnv = process.env): ToolchainReport {
  const { entries } = discoverToolchain(env);
  const pin = projectNodePin(root);
  const pinned = pin ? projectNodeBin(root, env) : null;
  return {
    entries,
    projectNode: pin
      ? {
          pin: pin.file,
          spec: pin.spec,
          bin: pinned?.bin ?? null,
          version: pinned?.version ?? null,
          match: pinned?.match ?? null,
        }
      : null,
  };
}

function toolchainLine(entry: ToolchainEntry): string {
  const where =
    entry.source === 'environment'
      ? 'from the environment'
      : entry.source === 'discovered'
        ? `found from ${entry.from ?? 'a standard location'}`
        : 'not found';
  const override = OVERRIDES[entry.name] ? `; ${OVERRIDES[entry.name]} to override` : '';
  return phaseLine(entry.name, `${entry.value ?? 'unset'} (${where}${override})`);
}

function toolchainLines(report: ToolchainReport): string[] {
  const project = report.projectNode;
  return [
    ...report.entries.map(toolchainLine),
    ...(project
      ? [
          phaseLine(
            'project node',
            !project.bin
              ? `${project.pin} pins ${project.spec}, which no nvm, fnm, Volta, asdf, mise or Homebrew install provides; Metro runs on the node on PATH`
              : project.match === 'major'
                ? `${project.version} at ${project.bin}, the newest installed Node of the major ${project.pin} pins and not older than ${project.spec}, since no install has ${project.spec}; Metro runs on it when the node on PATH does not fit the pin`
                : `${project.version} at ${project.bin}, which ${project.pin} pins (${project.spec}); Metro runs on it when the node on PATH does not satisfy the pin`,
          ),
        ]
      : []),
  ];
}

function budgetLines(budget: BudgetReport | null): string[] {
  return budget ? [phaseLine('budget', budgetLine(budget))] : [];
}

export function doctorSuccessLines(
  platform: DoctorPlatform | undefined,
  stim: StimVersionReport,
  budget: BudgetReport | null = null,
  projectLines: string[] = [],
  toolchain: string[] = [],
): string[] {
  return [
    `Doctor (${doctorTarget(platform)})`,
    phaseLine('result', 'PASS'),
    phaseLine('findings', '0'),
    ...stimVersionLines(stim),
    ...budgetLines(budget),
    ...(toolchain.length ? ['', 'Toolchain', ...toolchain] : []),
    '',
    'Shared',
    phaseLine('settings', 'every Stim setting type, machine config paths, companions and inert keys'),
    phaseLine('storage', 'temporary staging and build-cache volume placement'),
    ...projectLines,
  ];
}

export function shadowedStimFinding(report: StimVersionReport): Finding | null {
  if (!report.resolvedIsOlder || !report.resolved?.version || !report.highestVersion) return null;
  const newer = [
    ...((compareStimVersions(report.runningVersion, report.resolved.version) ?? 0) > 0
      ? [{ path: report.runningPath, version: report.runningVersion }]
      : []),
    ...report.installations.filter(
      (entry) => entry.version && (compareStimVersions(entry.version, report.resolved?.version ?? '') ?? 0) > 0,
    ),
  ].find((entry) => entry.version === report.highestVersion);
  const newerLocation = newer?.path ? ` at ${newer.path}` : '';
  return {
    level: 'cost',
    title: 'The Stim resolved from PATH is older than another installation',
    detail: `${report.resolved.path} reports ${report.resolved.version}, while ${report.highestVersion} is also installed${newerLocation}. A shell command named stim uses the first executable on PATH, so newer commands and fixes can appear to be missing.`,
    fix: `Update or remove ${report.resolved.path}, or put the ${report.highestVersion} installation earlier on PATH. Then run \`stim doctor\` again.`,
  };
}

/**
 * Status goes to stderr so `--json --fix` still prints one parseable payload
 * on stdout, and the report that follows shows what the write left.
 */
export function applySandboxFix(
  settingsRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  note: (message: string) => void = console.error,
): 0 | 1 {
  const harness = detectHarness(env);
  if (harness === 'codex') {
    note(chalk.yellow('Nothing to apply under Codex.'));
    note(
      chalk.dim(
        'Its sandbox is one setting, `sandbox_mode`, with no per-path allowance: the only value that clears Stim is `danger-full-access`, which turns the sandbox off rather than allowing these three. Run Stim with the sandbox off instead, or set it yourself.',
      ),
    );
    return 1;
  }
  if (harness !== 'claude-code') {
    note(chalk.dim('No sandboxing harness detected, so there is nothing to apply.'));
    return 0;
  }

  const stimHome = env.STIM_HOME || '~/.stim';
  const target = claudeLocalSettingsPath(settingsRoot);
  const missing = missingAllowance(allowanceSearchPaths(settingsRoot, env.HOME ?? env.USERPROFILE), stimHome);
  if (missing.length === 0) {
    note(chalk.green('Stim is already allowed through this sandbox. Nothing to apply.'));
    return 0;
  }

  const result = applyClaudeAllowance(target, sandboxAllowance(stimHome));
  if (result.status === 'refused') {
    note(chalk.red(result.reason));
    note(chalk.dim(`Nothing was written. Add ${missing.join(', ')} by hand.`));
    return 1;
  }
  note(chalk.green(`${result.status === 'created' ? 'Wrote' : 'Updated'} ${target}`));
  note(
    chalk.dim(
      "Added writes to Stim's state directory, the simulator XPC service, and local port binding. Claude Code reads project settings from the directory a session starts in, so this file only counts for sessions rooted there. Restart the session for it to take effect.",
    ),
  );
  return 0;
}

interface PreparedDoctor {
  settingsContext: ProjectSettingsContext;
  machineSettings: MachineSettings;
  settings: SettingsObject | null;
  selected: ReturnType<ProjectRegistry['selectDoctor']>;
  doctors: ProjectDoctor[];
}

async function prepareDoctor(
  root: string,
  platform: DoctorPlatform | undefined,
  registry: Pick<ProjectRegistry, 'selectDoctor'>,
  operation?: StimContext,
): Promise<PreparedDoctor> {
  const settingsContext = await projectSettingsContextAsync(root, undefined, {
    env: operation?.env ?? process.env,
    signal: operation?.signal,
  });
  const machineSettings = readMachineSettings(settingsContext);
  const settings = machineSettings.corrupt ? null : machineSettings.settings;
  const selected = registry.selectDoctor(root, platform);
  const doctors = await selected.load();
  return { settingsContext, machineSettings, settings, selected, doctors };
}

export interface DoctorReport {
  project: string;
  platform: DoctorPlatform | null;
  stim: StimVersionReport;
  budget: BudgetReport | null;
  maintenance: ReturnType<typeof maintenanceStatus> & { logPath: string };
  remoteMachines: BuildMachinesInspection['machines'];
  deviceHosts: Awaited<ReturnType<typeof inspectDeviceHostMachines>>['machines'];
  toolchain: ToolchainReport | null;
  findings: Finding[];
}

async function repairDoctorProject(
  root: string,
  platform: DoctorPlatform | undefined,
  prepared: PreparedDoctor,
  env: NodeJS.ProcessEnv,
  note: (message: string) => void,
  operation?: StimContext,
): Promise<0 | 1> {
  const { settingsContext, settings, doctors } = prepared;
  const signal = operation?.signal;
  const settingsRoot = settingsContext.repoRoot ?? root;
  let exitCode: 0 | 1 = 0;
  signal?.throwIfAborted();
  if (sandboxFinding(settingsRoot, { env, home: env.HOME ?? env.USERPROFILE, stimHome: env.STIM_HOME })) {
    exitCode = applySandboxFix(settingsRoot, env, note);
  }
  for (const doctor of doctors) {
    signal?.throwIfAborted();
    if (!doctor.repair) continue;
    try {
      const repair = await doctor.repair(platform, settings, settingsContext.repoRoot, operation);
      signal?.throwIfAborted();
      for (const path of repair.removed) note(phaseLine('cache', `removed ${path}; next build reconfigures`));
      for (const { path, reason } of repair.refused) note(phaseLine('cache', `kept ${path}: ${reason}`));
      if (repair.refused.length > 0) exitCode = 1;
    } catch (error) {
      if (
        error instanceof Error &&
        ('reportCleanup' in error || ('code' in error && error.code === 'STIM_CLAIM_UNAVAILABLE'))
      )
        throw error;
      signal?.throwIfAborted();
      note(phaseLine('cache', `Project repair failed: ${(error as Error).message}`));
      exitCode = 1;
    }
  }
  const nestedToFix = await inspectNestedWorktrees(root);
  signal?.throwIfAborted();
  const watchedToFix = await watchedCheckouts(nestedToFix.map((entry) => entry.checkout));
  for (const entry of nestedToFix) {
    signal?.throwIfAborted();
    let result: ReturnType<typeof writeIgnoreDirs>;
    try {
      result = writeIgnoreDirs(entry);
    } catch (error) {
      result = {
        status: 'refused',
        reason: `${entry.configPath} could not be written: ${(error as Error).message}`,
      };
    }
    if (result.status === 'refused') {
      note(phaseLine('checkout', `kept ${result.reason}; add ${entry.add.join(', ')} to ignore_dirs by hand`));
      exitCode = 1;
    } else {
      note(phaseLine('checkout', `${result.status} ${entry.configPath}: ignore_dirs ${entry.add.join(', ')}`));
      if (watchedToFix.has(entry.checkout))
        note(
          phaseLine(
            'checkout',
            `Watchman watches ${entry.checkout} and reads the file only when it adds a root: run \`watchman watch-del ${entry.checkout}\`, then restart watchman to free its memory`,
          ),
        );
    }
  }
  return exitCode;
}

export async function repairDoctorReport(
  operation: StimContext,
  platform: DoctorPlatform | undefined,
  version: string,
  beforeRepair?: (workspace: string) => void,
): Promise<{ report: DoctorReport; exitCode: 0 | 1 }> {
  const root = projectRegistry.findProjectRoot(operation.projectRoot);
  if (!root) throw Object.assign(new Error(NO_PROJECT_REFUSAL.message), NO_PROJECT_REFUSAL);
  beforeRepair?.(root);
  operation.signal.throwIfAborted();
  const prepared = await prepareDoctor(root, platform, projectRegistry, operation);
  const exitCode = await repairDoctorProject(
    root,
    platform,
    prepared,
    operation.env,
    (message) => operation.output('stderr', `${message}\n`),
    operation,
  );
  operation.signal.throwIfAborted();
  const report = await assembleDoctorReport(
    root,
    { platform, fix: true },
    version,
    prepared,
    (runningVersion) =>
      inspectStimVersions(runningVersion, { operation, cwd: root, env: operation.env, runningPath: '' }),
    process.platform,
    operation,
  );
  return { report, exitCode };
}

export async function readDoctorReport(
  operation: StimContext,
  platform: DoctorPlatform | undefined,
  version: string,
  requestAccess = false,
): Promise<DoctorReport> {
  const found = projectRegistry.findProjectRoot(operation.projectRoot);
  if (!found) throw Object.assign(new Error(NO_PROJECT_REFUSAL.message), NO_PROJECT_REFUSAL);
  const root = found;
  const prepared = await prepareDoctor(root, platform, projectRegistry, operation);
  return assembleDoctorReport(
    root,
    { platform, fix: requestAccess },
    version,
    prepared,
    (runningVersion) =>
      inspectStimVersions(runningVersion, {
        operation,
        cwd: root,
        env: operation.env,
        runningPath: '',
      }),
    process.platform,
    operation,
  );
}

async function assembleDoctorReport(
  root: string,
  opts: DoctorOptions,
  version: string,
  prepared: PreparedDoctor,
  inspectVersions: (version: string) => StimVersionReport | Promise<StimVersionReport>,
  host: NodeJS.Platform,
  operation?: StimContext,
): Promise<DoctorReport> {
  const { settingsContext, machineSettings, settings, selected, doctors } = prepared;
  const env = operation?.env ?? process.env;
  const io = doctorIo(operation);
  const stim = await inspectVersions(version);

  const { findings, context } = await runDoctor(
    root,
    {
      xcodeMajor: selected.platforms.includes('ios') && host === 'darwin' ? await detectXcodeMajorAsync() : null,
      platform: opts.platform,
      platforms: selected.platforms,
      host,
      machineSettings,
      repoRoot: settingsContext.repoRoot,
      remoteEnv: env,
      operation,
      tailnetStatus: io.status,
    },
    doctors.map((doctor) => doctor.inspect),
  );
  findings.unshift(...(await checkWorktreeStorageLayout(context)));
  if (selected.problem)
    findings.unshift({
      level: 'cost',
      ...(selected.problem.kind === 'not-an-app' ? { code: 'not-an-app' } : {}),
      title:
        selected.problem.kind === 'unreadable'
          ? 'The project could not be read'
          : 'This directory has no supported app for this operation',
      detail: selected.problem.message,
      fix: selected.problem.remedy,
    });
  for (const doctor of doctors) {
    if (doctor.inspectAsync) findings.push(...(await doctor.inspectAsync(context)));
  }

  if (detectHarness(env)) {
    const sandbox = sandboxFinding(settingsContext.repoRoot ?? root, {
      env,
      home: env.HOME ?? env.USERPROFILE,
      stimHome: operation?.home ?? env.STIM_HOME,
    });
    if (sandbox) findings.push(sandbox);
  }

  const shadowed = shadowedStimFinding(stim);
  if (shadowed) findings.push(shadowed);

  const budget = await inspectBudget(root, undefined, env, operation);
  findings.push(...budget.findings);
  const watchmanMemory = withoutUnhandledRejection(inspectWatchmanMemory(env, operation));
  const tickets: GeneratedTickets = new Map();
  const deviceHosts = withoutUnhandledRejection(
    inspectDeviceHostMachines({ fix: opts.fix === true, version, tickets, operation }, io),
  );
  const nestedWorktrees = await inspectNestedWorktrees(root);
  const watched = withoutUnhandledRejection(watchedCheckouts(nestedWorktrees.map((entry) => entry.checkout)));
  const targetInspectors = doctors.flatMap((doctor) => {
    const inspect = doctor.offloadTargets?.(context, () => iosTargetRuntime(root, settings));
    return inspect ? [inspect] : [];
  });
  const remoteMachinesInspection = withoutUnhandledRejection(
    inspectBuildMachines(
      {
        fix: opts.fix === true,
        version,
        tickets,
        operation,
        check: targetInspectors.length
          ? offloadCheck(root, async () => (await Promise.all(targetInspectors.map((inspect) => inspect()))).flat())
          : null,
      },
      io,
    ),
  );

  const watchman = await watchmanMemory;
  if (watchman) findings.push(watchman);
  if (!memorySweepIsScoped(env)) findings.push(...memoryCulpritFindings(await readMemoryCulpritsAsync()));
  const watchedRoots = await watched;
  for (const entry of nestedWorktrees) findings.push(nestedWorktreeFinding(entry, watchedRoots.has(entry.checkout)));
  const remoteMachines = await remoteMachinesInspection;
  findings.push(...remoteMachines.findings);
  const deviceHostMachines = await deviceHosts;
  const reported = new Set(remoteMachines.findings.map((each) => each.title));
  findings.push(...deviceHostMachines.findings.filter((each) => !reported.has(each.title)));
  const agentDriver = inspectHostedAgentDriver();
  if (agentDriver) findings.push(agentDriver);

  const toolchain = host === 'darwin' ? toolchainReport(root, env) : null;
  const maintenance = maintenanceStatus(env);
  return {
    project: root,
    platform: opts.platform ?? null,
    stim,
    budget: budget.report,
    maintenance: { ...maintenance, logPath: maintenanceNdjsonFile() },
    remoteMachines: remoteMachines.machines,
    deviceHosts: deviceHostMachines.machines,
    toolchain,
    findings,
  };
}

export default function doctorCommand(
  program: Command,
  version: string,
  inspectVersions: (version: string) => StimVersionReport | Promise<StimVersionReport> = inspectStimVersions,
  host: NodeJS.Platform = process.platform,
  registry: Pick<ProjectRegistry, 'findProjectRoot' | 'selectDoctor'> = projectRegistry,
): void {
  program
    .command('doctor')
    .description(
      'Inspect the source checkout and report project state that can make native worktrees slow or invalid. The checkout is left untouched unless --fix is passed; --platform filters native findings. Each run in a supported native app is recorded in Stim state so guide can say when doctor is due.',
    )
    .option('--json', 'print the findings as JSON')
    .option(
      '--platform <platform>',
      'report shared findings plus only this native platform: ios or android',
      parseDoctorPlatform,
    )
    .option(
      '--fix',
      'repair the sandbox allowance when the report names it, and stale Android .cxx configurations in a React Native or Expo checkout; add linked worktrees nested in a checkout to its .watchmanconfig ignore_dirs; ask each remote machine in remote.machines for build and device-host approval. Stop native builds first. Generated CMake output must be ignored and untracked; custom launcher settings and source files are preserved.',
    )
    .action(async (opts: DoctorOptions) => {
      const root = registry.findProjectRoot(process.cwd());
      if (!root) {
        refuseNoProject({ json: Boolean(opts.json) });
        return;
      }
      const prepared = await prepareDoctor(root, opts.platform, registry);
      const { selected, doctors } = prepared;

      if (opts.fix && (await repairDoctorProject(root, opts.platform, prepared, process.env, console.error))) {
        process.exitCode = 1;
      }

      const report = await assembleDoctorReport(root, opts, version, prepared, inspectVersions, host);
      const { findings, stim, toolchain, maintenance } = report;
      const budget = { report: report.budget };
      const maintenanceLines = [
        phaseLine('maintenance.mode', maintenance.mode),
        phaseLine('maintenance log', maintenanceNdjsonFile()),
        phaseLine('last pass', maintenanceLine(maintenance, false) ?? 'no pass has run yet'),
      ];
      if (opts.json) {
        console.log(JSON.stringify(report));
        recordDoctorRun(root, opts.platform, version, undefined, selected.platforms);
        return;
      }

      if (findings.length === 0) {
        const lines = [
          ...doctorSuccessLines(
            opts.platform,
            stim,
            budget.report,
            doctors.flatMap((doctor) => doctor.successLines?.(opts.platform) ?? []),
            toolchain ? toolchainLines(toolchain) : [],
          ),
          ...maintenanceLines,
        ];
        for (const [index, line] of lines.entries()) {
          if (index === 1) console.log(chalk.green(line));
          else if (line && !line.startsWith('  ')) console.log(chalk.bold(line));
          else console.log(chalk.dim(line));
        }
        recordDoctorRun(root, opts.platform, version, undefined, selected.platforms);
        return;
      }

      const ordered = findings.toSorted((a, b) => (a.level === b.level ? 0 : a.level === 'cost' ? -1 : 1));
      console.log(chalk.bold(`Doctor (${doctorTarget(opts.platform)})`));
      for (const line of [...stimVersionLines(stim), ...budgetLines(budget.report), ...maintenanceLines])
        console.log(chalk.dim(line));
      if (toolchain) {
        console.log(chalk.bold('\nToolchain'));
        for (const line of toolchainLines(toolchain)) console.log(chalk.dim(line));
      }
      for (const f of ordered) {
        const tag = f.level === 'cost' ? chalk.yellow('costs time') : chalk.dim('note');
        console.log(`\n${tag}  ${chalk.bold(f.title)}`);
        console.log(`  ${f.detail}`);
        if (f.fix) console.log(chalk.dim(`  -> ${f.fix}`));
      }

      console.log(
        chalk.dim(
          `\n${findings.length} finding(s). Fix relevant "costs time" findings before copying the source checkout into a native worktree.`,
        ),
      );
      recordDoctorRun(root, opts.platform, version, undefined, selected.platforms);
    });
}
