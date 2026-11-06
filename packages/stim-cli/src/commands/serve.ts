import { Command, Option } from 'commander';
import { bundledStim } from '../../../server/src/environment.ts';
import { loadServerCli } from '../server-cli.ts';
import { DEFAULT_PORT, validateServeEnvironment } from '../../../server/src/service-plist.ts';
import pairCommand from './pair.ts';
import pairingsCommand from './pairings.ts';
import serviceCommand from './service.ts';
import setupCommand from './setup.ts';

export default function serveCommand(program: Command, version: string, legacy = false): void {
  const command = legacy ? program : program.command('serve').description('Serve paired clients').version(version);
  command
    .option('--port <n>', 'server port', String(DEFAULT_PORT))
    .option('--loopback-only', 'serve this machine only')
    .option('--share', 'serve web shares until the last share ends')
    .addOption(new Option('--service').hideHelp())
    .option(
      '--env <KEY=VALUE>',
      'set a server environment variable',
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--path-prepend <dir>',
      'prepend a server tool directory',
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .action(async (opts) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        command.error(`--port must be a port number, got ${opts.port}.`);
      const problem = validateServeEnvironment(opts.env, opts.pathPrepend, true);
      if (problem) command.error(problem);
      const { serve } = await loadServerCli();
      await serve(
        port,
        opts.env,
        opts.pathPrepend,
        opts.loopbackOnly === true || opts.share === true,
        opts.share === true,
      );
    });
}

export async function legacyMain(): Promise<void> {
  const program = new Command().name('stim-server').version(bundledStim().version).enablePositionalOptions();
  program.configureOutput({
    outputError: (message, write) => {
      const scope = /unknown option '(--(?:build|device-host))'/.exec(message);
      write(
        scope
          ? `stim-server: ${scope[1]} applies only to \`stim-server setup\`, which a person runs on this machine with the requesting machine's setup ticket.\n`
          : message,
      );
    },
  });
  serveCommand(program, bundledStim().version, true);
  pairCommand(program);
  pairingsCommand(program, undefined, 'devices');
  serviceCommand(program);
  setupCommand(program);
  await program.parseAsync();
}
