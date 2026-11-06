import type { Command } from 'commander';
import { loadServerCli } from '../server-cli.ts';

export default function setupCommand(program: Command): void {
  program
    .command('setup')
    .description('Approve the machine holding STIM_SETUP_TICKET on this worker')
    .option('--expires <iso>', 'approval expiry')
    .option('--build', 'approve builds')
    .option('--device-host', 'approve hosted devices')
    .option('--port <n>', 'server port')
    .option('--label <name>', 'service label')
    .option('--env <KEY=VALUE>', 'set a server environment variable')
    .option('--path-prepend <dir>', 'prepend a server tool directory')
    .option('--yes', 'approve without a terminal prompt')
    .option('--json', 'print the result as JSON')
    .option('--verbose', 'print setup details')
    .option('--no-wait', 'interrupt active builds and hosted installs')
    .action(async () => {
      const { setup } = await loadServerCli();
      await setup(process.argv.slice(3));
    });
}
