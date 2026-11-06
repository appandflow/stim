import type { Command } from 'commander';
import { grant, listPairings, logActions, rename, revoke } from '../../../server/src/cli.ts';

export default function pairingsCommand(program: Command, _version?: string, name = 'pairings'): void {
  const command = program.command(name).description('Manage paired devices, approved clients and hosted sessions');
  command.option('--json', 'print pairings as JSON').action((opts) => listPairings(opts.json === true));
  command
    .command('list')
    .option('--json', 'print pairings as JSON')
    .action((_opts, cmd: Command) => listPairings(cmd.optsWithGlobals().json === true));
  command
    .command('grant <id>')
    .option('--control', 'allow actions')
    .option('--read', 'allow only reading')
    .action(grant);
  command.command('revoke <id>').action(revoke);
  command.command('rename <id> <name>').action(rename);
  (name === 'devices' ? program : command)
    .command('log')
    .description('List the actions paired devices ran')
    .option('--json', 'print actions as JSON')
    .action((_opts, cmd: Command) => logActions(cmd.optsWithGlobals().json === true));
}
