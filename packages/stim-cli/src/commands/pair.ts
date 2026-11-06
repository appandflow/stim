import type { Command } from 'commander';
import { loadServerCli } from '../server-cli.ts';
import { DEFAULT_PORT } from '../../../server/src/service-plist.ts';

export default function pairCommand(program: Command): void {
  const command = program.command('pair').description('Print a single-use pairing payload');
  command
    .option('--port <n>', 'server port', String(DEFAULT_PORT))
    .option('--control', 'allow the paired device to run actions')
    .option('--json', 'print pairing data as JSON')
    .action(async (opts) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        command.error(`--port must be a port number, got ${opts.port}.`);
      const { pair } = await loadServerCli();
      await pair(port, opts.json === true, opts.control === true);
    });
}
