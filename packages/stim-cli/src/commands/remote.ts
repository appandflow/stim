import chalk from 'chalk';
import type { Command } from 'commander';
import { readBuildMachines, readDeviceHostMachines } from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { phaseLine } from '../command-output.ts';
import { configuredMachines, forgetDeviceHostMachine, inspectDeviceHostMachines } from '../device-host/machines.ts';
import { forgetBuildMachine, inspectBuildMachines } from '../offload/build-machines.ts';
import {
  doctorIo,
  keyConfirmer,
  parseMachine,
  type GeneratedTickets,
  type TailnetMachineIo,
} from '../offload/tailnet.ts';
import { updateRemoteMachinesAsync } from '../workspace/config.ts';
import { confirmInTerminal } from './device-provision.ts';

type BuildReport = Awaited<ReturnType<typeof inspectBuildMachines>>['machines'][number];
type HostReport = Awaited<ReturnType<typeof inspectDeviceHostMachines>>['machines'][number];

interface Refusal {
  code: string;
  message: string;
  remedy: string | null;
}

function refusal(code: string, message: string, remedy: string | null): Error & Refusal {
  return Object.assign(new Error(message), { code, message, remedy });
}

function invalidSetting(): Error & Refusal {
  return refusal(
    'STIM_BAD_ARG',
    'remote.machines is not a list of machine names.',
    'Run `stim guide settings` and correct remote.machines, then run the command again.',
  );
}

function asRefusal(error: unknown): Refusal | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  if (typeof error.code !== 'string' || !error.code.startsWith('STIM_')) return null;
  const remedy = 'remedy' in error && typeof error.remedy === 'string' ? error.remedy : null;
  return { code: error.code, message: error.message, remedy };
}

async function run(json: boolean, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const failure = asRefusal(error);
    if (!failure) throw error;
    console.error(chalk.red(phaseLine('error', `${failure.code}: ${failure.message}`)));
    if (failure.remedy) console.error(phaseLine('remedy', failure.remedy));
    if (json) console.log(JSON.stringify(failure));
    process.exitCode = 1;
  }
}

function requireMachine(machine: string): void {
  if (parseMachine(machine)) return;
  throw refusal(
    'STIM_BAD_ARG',
    `${JSON.stringify(machine)} is not a tailnet name or local: address.`,
    'Expected `name`, `name:port`, `local:<host>` or `local:<host>:port`.',
  );
}

function printFindings(findings: Finding[]): void {
  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.title)) continue;
    seen.add(finding.title);
    console.log(`\n${chalk.bold(finding.title)}`);
    console.log(`  ${finding.detail}`);
    if (finding.fix) console.log(chalk.dim(`  -> ${finding.fix}`));
  }
}

function confirmer(json: boolean) {
  const interactive = !json && process.stdin.isTTY === true && process.stderr.isTTY === true;
  return keyConfirmer(interactive ? confirmInTerminal : null);
}

function stateLine(build: BuildReport | null, host: HostReport | null): string {
  return `build ${build?.state ?? 'unknown'}, device-host ${host?.state ?? 'unknown'}`;
}

export default function remoteCommand(program: Command, version: string, io: TailnetMachineIo = doctorIo()): void {
  const remote = program
    .command('remote')
    .description(
      'Manage remote.machines, the remote machines this machine builds on and hosts devices on. Works from any directory.',
    );

  remote
    .command('add <machine>')
    .description(
      'Append a remote machine to remote.machines, keeping the existing entries, and ask it for build and device-host approval. Prints the stim-server setup command a person runs there to approve this machine.',
    )
    .option('--json', 'print the result as JSON')
    .action((machine: string, opts: { json?: boolean }) =>
      run(Boolean(opts.json), async () => {
        requireMachine(machine);
        const { before, after } = await updateRemoteMachinesAsync(
          (machines) => (machines.includes(machine) ? machines : [...machines, machine]),
          await io.status(),
        );
        if (before === null) throw invalidSetting();
        const added = !before.includes(machine);
        const tickets: GeneratedTickets = new Map();
        const options = { fix: true, forget: false, version, tickets, confirmKey: confirmer(Boolean(opts.json)) };
        const build = await inspectBuildMachines(options, io, [machine]);
        const host = await inspectDeviceHostMachines(options, io, [machine]);
        const findings = [...build.findings, ...host.findings];
        const buildReport = build.machines[0] ?? null;
        const hostReport = host.machines[0] ?? null;
        if (opts.json) {
          console.log(
            JSON.stringify({ machine, added, machines: after, build: buildReport, deviceHost: hostReport, findings }),
          );
          return;
        }
        console.log(
          added
            ? `Added ${machine} to remote.machines (${after.length} machine${after.length === 1 ? '' : 's'}).`
            : `${machine} is already in remote.machines.`,
        );
        console.log(`${machine}: ${stateLine(buildReport, hostReport)}`);
        printFindings(findings);
      }),
    );

  remote
    .command('list')
    .description(
      'Contact each machine in remote.machines and report its build and device-host approval, in placement order. Completes the connection to a machine that approved since the last contact; asks nothing new.',
    )
    .option('--json', 'print the machines as JSON')
    .action((opts: { json?: boolean }) =>
      run(Boolean(opts.json), async () => {
        const entries = configuredMachines();
        if (entries === null) throw invalidSetting();
        const options = { fix: false, version, confirmKey: confirmer(Boolean(opts.json)) };
        const build = await inspectBuildMachines(options, io, entries);
        const host = await inspectDeviceHostMachines(options, io, entries);
        const machines = entries.map((machine, at) => ({
          machine,
          priority: at + 1,
          build: build.machines.find((each) => each.machine === machine) ?? null,
          deviceHost: host.machines.find((each) => each.machine === machine) ?? null,
        }));
        const findings = [...build.findings, ...host.findings];
        if (opts.json) {
          console.log(JSON.stringify({ machines, findings }));
          return;
        }
        if (!entries.length) {
          console.log('No remote machines. Add one with `stim remote add <machine>`.');
          return;
        }
        for (const each of machines)
          console.log(`${each.priority} ${each.machine}: ${stateLine(each.build, each.deviceHost)}`);
        printFindings(findings);
      }),
    );

  remote
    .command('remove <machine>')
    .description(
      "Remove a machine from remote.machines and forget this machine's credentials for it. Approval on that machine stays until a person there revokes it; prints the command.",
    )
    .option('--json', 'print the result as JSON')
    .action((machine: string, opts: { json?: boolean }) =>
      run(Boolean(opts.json), async () => {
        if (configuredMachines() === null) throw invalidSetting();
        const credentials = [...readBuildMachines(), ...readDeviceHostMachines()].filter(
          (each) => each.machine === machine,
        );
        const revoke = [...new Set(credentials.flatMap((each) => (each.deviceId ? [each.deviceId] : [])))].map(
          (id) => `stim-server devices revoke ${id}`,
        );
        const pending = credentials.some((each) => !each.deviceId);
        if (!(await forgetDeviceHostMachine(machine)))
          throw refusal(
            'STIM_CLAIM_REFUSED',
            `Another run holds the hosting credentials, so ${machine} was not removed.`,
            `Run \`stim remote remove ${machine}\` again after it finishes.`,
          );
        await forgetBuildMachine(machine);
        const { before, after } = await updateRemoteMachinesAsync(
          (machines) => machines.filter((each) => each !== machine),
          await io.status(),
        );
        if (before === null) throw invalidSetting();
        const removed = before.includes(machine);
        if (opts.json) {
          console.log(
            JSON.stringify({ machine, removed, forgot: credentials.length > 0, machines: after, revoke, pending }),
          );
          return;
        }
        if (!removed && !credentials.length) {
          console.log(`${machine} is not in remote.machines.`);
          return;
        }
        console.log(
          removed
            ? `Removed ${machine} from remote.machines and forgot its credentials.`
            : `${machine} was not in remote.machines; forgot its credentials.`,
        );
        if (revoke.length)
          console.log(
            chalk.dim(`  -> ${machine} keeps this machine's approval until a person there runs: ${revoke.join('; ')}`),
          );
        if (pending)
          console.log(
            chalk.dim(
              `  -> A request to ${machine} was still pending here. If a person there approved it, find this machine in \`stim-server devices\` there and revoke it.`,
            ),
          );
      }),
    );
}
