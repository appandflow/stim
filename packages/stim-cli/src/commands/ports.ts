import type { Command } from 'commander';
import { getProject } from '../workspace/config.ts';
import { clearNamedPorts, getNamedPort } from '../named-ports.ts';
import { findServerWorkspace } from '../workspace/project.ts';

async function inProject(action: (root: string) => Promise<void>): Promise<void> {
  try {
    const workspace = findServerWorkspace(process.cwd());
    if (!workspace) throw new Error('No package.json found. Run stim ports from the workspace that owns the server.');
    if (workspace.from) {
      console.error(`Using the Stim workspace ${workspace.root}: ${workspace.from} is not a React Native or Expo app.`);
    }
    await action(workspace.root);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

export default function portsCommand(program: Command): void {
  const ports = program.command('ports').description('Reserve workspace ports for servers Stim does not manage');
  ports.action(() =>
    inProject(async (root) => {
      const project = getProject(root);
      const rows = Object.entries(project?.ports ?? {});
      if (typeof project?.metroPort === 'number') rows.push(['metro (managed)', project.metroPort]);
      if (!rows.length) {
        console.log('No ports allocated. Use stim ports get <label>.');
        return;
      }
      const width = Math.max(...rows.map(([name]) => name.length));
      for (const [name, port] of rows) console.log(`${name.padEnd(width)}  ${port}`);
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
      inProject((root) => clearNamedPorts(root, { label, stop: true, dryRun: opts.dryRun })),
    );
  ports
    .command('release [label]')
    .description('Release named ports without stopping their listeners; excludes Metro')
    .action((label: string | undefined) => inProject((root) => clearNamedPorts(root, { label })));
}
