import type { Command } from 'commander';
import { getProject } from '../workspace/config.ts';
import { clearNamedPorts, getNamedPort } from '../named-ports.ts';
import { findCommandWorkspace } from '../workspace/project.ts';
import { reversePorts } from '@stim-cli/core/state';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import {
  dropLabelReverses,
  recordReversePort,
  resolveReversePort,
  reverseOnDevices,
  type ReverseDeviceReport,
} from '../reverse-ports.ts';

function warnFailed(reports: ReverseDeviceReport[]): void {
  for (const report of reports)
    if (report.status === 'failed')
      console.error(`could not remove the reverse from ${report.device}: ${report.detail}`);
}

async function inProject(action: (root: string) => Promise<void>): Promise<void> {
  try {
    const root = findCommandWorkspace(process.cwd());
    if (!root) throw new Error('No package.json found. Run stim ports from the workspace that owns the server.');
    await action(root);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

export default function portsCommand(program: Command): void {
  program.enablePositionalOptions();
  const ports = program.command('ports').description('Reserve workspace ports for servers Stim does not manage');
  ports
    .enablePositionalOptions()
    .option('--json', 'print one JSON payload')
    .action((opts: { json?: boolean }) =>
      inProject(async (root) => {
        const project = getProject(root);
        const reversed = reversePorts(readWorkspaceState(root));
        const labels = Object.entries(project?.ports ?? {});
        const rows = labels.map(([name, port]): [string, number, boolean] => [
          name === 'web-cdp' ? 'web-cdp (managed)' : name,
          port,
          reversed.includes(port),
        ]);
        if (typeof project?.metroPort === 'number') rows.push(['metro (managed)', project.metroPort, false]);
        for (const port of reversed)
          if (!labels.some(([, each]) => each === port)) rows.push(['(unlabelled)', port, true]);
        if (opts.json) {
          console.log(
            JSON.stringify({
              ports: labels.map(([label, port]) => ({ label, port, managed: label === 'web-cdp' })),
              metroPort: project?.metroPort ?? null,
              reverses: reversed.map((port) => ({
                port,
                label: labels.find(([, each]) => each === port)?.[0] ?? null,
              })),
            }),
          );
          return;
        }
        if (!rows.length) {
          console.log('No ports allocated. Use stim ports get <label>.');
          return;
        }
        const width = Math.max(...rows.map(([name]) => name.length));
        for (const [name, port, reverse] of rows)
          console.log(`${name.padEnd(width)}  ${port}${reverse ? '  reversed' : ''}`);
      }),
    );
  ports
    .command('get <label>')
    .description('Allocate once and print only the port number')
    .action((label: string) =>
      inProject(async (root) => {
        console.log(await getNamedPort(root, label));
      }),
    );
  ports
    .command('stop [label]')
    .description('Stop TCP listeners and release named ports; excludes Metro')
    .option('--dry-run', 'show the listeners and allocations that would be stopped and released')
    .action((label: string | undefined, opts: { dryRun?: boolean }) =>
      inProject(async (root) => {
        if (!opts.dryRun) warnFailed(await dropLabelReverses(root, label));
        await clearNamedPorts(root, { label, stop: true, dryRun: opts.dryRun });
      }),
    );
  ports
    .command('release [label]')
    .description('Release named ports without stopping their listeners; excludes Metro')
    .action((label: string | undefined) =>
      inProject(async (root) => {
        warnFailed(await dropLabelReverses(root, label));
        await clearNamedPorts(root, { label });
      }),
    );
  ports
    .command('reverse <target>')
    .description('Make a server on this machine reachable at the same localhost port from the workspace devices')
    .option('--remove', 'remove the reverse')
    .option('--json', 'print one JSON payload')
    .action((target: string, opts: { remove?: boolean; json?: boolean }) =>
      inProject(async (root) => {
        const port = resolveReversePort(root, target);
        const action = opts.remove ? 'remove' : 'add';
        const recorded = await recordReversePort(root, port, !opts.remove);
        const devices = await reverseOnDevices(root, port, action);
        if (devices.some((device) => device.status === 'failed' || device.status === 'unsupported'))
          process.exitCode = 1;
        if (opts.json) {
          console.log(JSON.stringify({ action, port, ports: recorded, devices }));
          return;
        }
        console.log(reverseSummary(port, action, devices));
      }),
    );
}

function reverseSummary(port: number, action: 'add' | 'remove', devices: ReverseDeviceReport[]): string {
  const lines = devices.map((device) => `${device.status}  ${device.platform} ${device.device}: ${device.detail}`);
  if (!devices.length)
    lines.push(
      action === 'add'
        ? `recorded  no device yet; stim ios and stim android make localhost:${port} reachable when they launch`
        : 'removed  no device had it',
    );
  return [`${action === 'add' ? 'reverse' : 'unreverse'} ${port}`, ...lines.map((line) => `  ${line}`)].join('\n');
}
