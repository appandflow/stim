import type { Command } from 'commander';
import { loadServerCli } from '../server-cli.ts';
import { DEFAULT_PORT } from '@stim-cli/server/service-plist';

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
      const { ensureNet } = await import('../daemon/client.ts');
      const answer = await ensureNet(false);
      if (!answer) console.error('No stimd runs to take this pairing; run stim serve.');
      else if (!answer.listening) console.error(answer.message);
      else if (answer.port !== port)
        console.error(
          `stimd's server listens on port ${answer.port}, not ${port}; pair again with --port ${answer.port}.`,
        );
    });
}
