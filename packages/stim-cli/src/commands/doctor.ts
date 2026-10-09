import { maintenanceNdjsonFile } from '@stim-cli/core/state';
import { maintenanceStatus, maintenanceLine } from '../maintenance/status.ts';
import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { recordDoctorRun } from '../guide-status.ts';
import { projectRegistry } from '../integrations/projects.ts';
import type { ProjectRegistry } from '../integrations/project-registry.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { getProject } from '../workspace/config.ts';
import { resolveSettings } from '../workspace/settings.ts';
import { iosRuntimeMatches, listIosRuntimes, pickDefaultIosCreation } from '../devices/ios.ts';
import { offloadCheck, simulatorRuntime } from '../offload/client.ts';
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
import { detectXcodeMajor, runDoctor } from '../diagnostics/doctor.ts';
import type { DoctorPlatform, Finding } from '../diagnostics/doctor.ts';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { compareStimVersions, inspectStimVersions, type StimVersionReport } from '../diagnostics/stim-installations.ts';
import { budgetLine, inspectBudget, type BudgetReport } from '../budget.ts';
import { inspectBuildMachines } from '../offload/build-machines.ts';
import { inspectHostedAgentDriver } from '../device-host/agent-driver.ts';
import { inspectDeviceHostMachines } from '../device-host/machines.ts';
import { inspectWatchmanMemory } from './gc/memory.ts';

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
function iosTargetRuntime(root: string): string | null {
  try {
    const settings = resolveSettings({
      projectPath: root,
      gitCommonDir: gitCommonDir(root),
      repoRoot: repoRoot(root) ?? root,
    });
    const runtimes = listIosRuntimes();
    const runtime = resolveRuntime(null, settings);
    if (runtime) return runtimes.find((each) => iosRuntimeMatches(each, runtime))?.identifier ?? null;
    const udid = getProject(root)?.platforms?.ios?.deviceUdid;
    const own = typeof udid === 'string' ? simulatorRuntime(udid) : null;
    if (own) return own;
    const deviceType = resolveDeviceType(null, settings) ?? undefined;
    return pickDefaultIosCreation([], runtimes, { deviceType })?.runtimeId ?? null;
  } catch {
    return null;
  }
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

function budgetLines(budget: BudgetReport | null): string[] {
  return budget ? [phaseLine('budget', budgetLine(budget))] : [];
}

export function doctorSuccessLines(
  platform: DoctorPlatform | undefined,
  stim: StimVersionReport,
  budget: BudgetReport | null = null,
  projectLines: string[] = [],
): string[] {
  return [
    `Doctor (${doctorTarget(platform)})`,
    phaseLine('result', 'PASS'),
    phaseLine('findings', '0'),
    ...stimVersionLines(stim),
    ...budgetLines(budget),
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
export function applySandboxFix(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const harness = detectHarness(env);
  if (harness === 'codex') {
    console.error(chalk.yellow('Nothing to apply under Codex.'));
    console.error(
      chalk.dim(
        'Its sandbox is one setting, `sandbox_mode`, with no per-path allowance: the only value that clears Stim is `danger-full-access`, which turns the sandbox off rather than allowing these three. Run Stim with the sandbox off instead, or set it yourself.',
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (harness !== 'claude-code') {
    console.error(chalk.dim('No sandboxing harness detected, so there is nothing to apply.'));
    return;
  }

  const settingsRoot = repoRoot(root) ?? root;
  const stimHome = env.STIM_HOME || '~/.stim';
  const target = claudeLocalSettingsPath(settingsRoot);
  const missing = missingAllowance(allowanceSearchPaths(settingsRoot), stimHome);
  if (missing.length === 0) {
    console.error(chalk.green('Stim is already allowed through this sandbox. Nothing to apply.'));
    return;
  }

  const result = applyClaudeAllowance(target, sandboxAllowance(stimHome));
  if (result.status === 'refused') {
    console.error(chalk.red(result.reason));
    console.error(chalk.dim(`Nothing was written. Add ${missing.join(', ')} by hand.`));
    process.exitCode = 1;
    return;
  }
  console.error(chalk.green(`${result.status === 'created' ? 'Wrote' : 'Updated'} ${target}`));
  console.error(
    chalk.dim(
      "Added writes to Stim's state directory, the simulator XPC service, and local port binding. Claude Code reads project settings from the directory a session starts in, so this file only counts for sessions rooted there. Restart the session for it to take effect.",
    ),
  );
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
      'repair the sandbox allowance when the report names it, and stale Android .cxx configurations in this checkout; ask each remote Mac in remote.machines for build and device-host approval. Stop native builds first. Generated CMake output must be ignored and untracked; custom launcher settings and source files are preserved.',
    )
    .action(async (opts: DoctorOptions) => {
      const root = registry.findProjectRoot(process.cwd());
      if (!root) {
        refuseNoProject({ json: Boolean(opts.json) });
        return;
      }

      const selected = registry.selectDoctor(root, opts.platform);
      const doctors = await selected.load();

      if (opts.fix) {
        if (sandboxFinding(repoRoot(root) ?? root)) applySandboxFix(root);
        for (const doctor of doctors) {
          if (!doctor.repair) continue;
          try {
            const repair = doctor.repair(opts.platform);
            for (const path of repair.removed)
              console.error(phaseLine('cache', `removed ${path}; next build reconfigures`));
            for (const { path, reason } of repair.refused) console.error(phaseLine('cache', `kept ${path}: ${reason}`));
            if (repair.refused.length > 0) process.exitCode = 1;
          } catch (error) {
            console.error(phaseLine('cache', `Project repair failed: ${(error as Error).message}`));
            process.exitCode = 1;
          }
        }
      }

      const stim = await inspectVersions(version);

      const { findings, context } = runDoctor(
        root,
        {
          xcodeMajor: selected.platforms.includes('ios') && host === 'darwin' ? detectXcodeMajor() : null,
          platform: opts.platform,
          platforms: selected.platforms,
          host,
        },
        doctors.map((doctor) => doctor.inspect),
      );
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

      if (detectHarness()) {
        const sandbox = sandboxFinding(repoRoot(root) ?? root);
        if (sandbox) findings.push(sandbox);
      }

      const shadowed = shadowedStimFinding(stim);
      if (shadowed) findings.push(shadowed);

      const budget = await inspectBudget(root);
      findings.push(...budget.findings);
      const watchman = await inspectWatchmanMemory();
      if (watchman) findings.push(watchman);
      const targetInspectors = doctors.flatMap((doctor) => {
        const inspect = doctor.offloadTargets?.(context, () => iosTargetRuntime(root));
        return inspect ? [inspect] : [];
      });
      const remoteMachines = await inspectBuildMachines({
        fix: opts.fix === true,
        check: targetInspectors.length
          ? offloadCheck(root, () => targetInspectors.flatMap((inspect) => inspect()))
          : null,
      });
      findings.push(...remoteMachines.findings);
      const deviceHosts = await inspectDeviceHostMachines({ fix: opts.fix === true });
      const reported = new Set(remoteMachines.findings.map((each) => each.title));
      findings.push(...deviceHosts.findings.filter((each) => !reported.has(each.title)));
      const agentDriver = inspectHostedAgentDriver();
      if (agentDriver) findings.push(agentDriver);

      const maintenance = maintenanceStatus();
      const maintenanceLines = [
        phaseLine('maintenance.mode', maintenance.mode),
        phaseLine('maintenance log', maintenanceNdjsonFile()),
        phaseLine('last pass', maintenanceLine(maintenance, false) ?? 'no pass has run yet'),
      ];
      if (opts.json) {
        console.log(
          JSON.stringify({
            project: root,
            platform: opts.platform ?? null,
            stim,
            budget: budget.report,
            maintenance: { ...maintenance, logPath: maintenanceNdjsonFile() },
            remoteMachines: remoteMachines.machines,
            deviceHosts: deviceHosts.machines,
            findings,
          }),
        );
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
