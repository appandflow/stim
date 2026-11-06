import type { Command } from 'commander';
import { loadServerCli } from '../server-cli.ts';

export default function pairingsCommand(program: Command, _version?: string, name = 'pairings'): void {
  const command = program.command(name).description('Manage paired devices, approved clients and hosted sessions');
  command.option('--json', 'print pairings as JSON').action(async (opts) => {
    const { listPairings } = await loadServerCli();
    listPairings(opts.json === true);
  });
  command
    .command('list')
    .option('--json', 'print pairings as JSON')
    .action(async (_opts, cmd: Command) => {
      const { listPairings } = await loadServerCli();
      listPairings(cmd.optsWithGlobals().json === true);
    });
  command
    .command('grant <id>')
    .option('--control', 'allow actions')
    .option('--read', 'allow only reading')
    .action(async (id, opts) => {
      const { grant } = await loadServerCli();
      grant(id, opts);
    });
  command.command('revoke <id>').action(async (id) => {
    const { revoke } = await loadServerCli();
    revoke(id);
  });
  command.command('rename <id> <name>').action(async (id, newName) => {
    const { rename } = await loadServerCli();
    rename(id, newName);
  });
  (name === 'devices' ? program : command)
    .command('log')
    .description('List the actions paired devices ran')
    .option('--json', 'print actions as JSON')
    .action(async (_opts, cmd: Command) => {
      const { logActions } = await loadServerCli();
      logActions(cmd.optsWithGlobals().json === true);
    });
}
