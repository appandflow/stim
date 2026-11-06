import type { Command } from 'commander';
import { loadServerCli } from '../server-cli.ts';
import { DEFAULT_LABEL, validateServeEnvironment } from '@stim-cli/server/service-plist';

export default function serviceCommand(program: Command): void {
  const service = program.command('service').description('Manage the per-user server service');
  for (const name of ['install', 'status', 'update', 'rollback', 'uninstall']) {
    const command = service
      .command(name)
      .option('--label <name>', 'service label', name === 'install' ? undefined : DEFAULT_LABEL);
    if (name === 'install')
      command
        .option('--port <n>', 'server port')
        .option('--serve', 'add a tailnet-only Tailscale route')
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
        );
    if (name === 'status') command.option('--json', 'print status as JSON');
    if (name === 'update')
      command
        .option('--release <version>', 'install an npm release')
        .option('--from <dir>', 'install packaged releases from a directory')
        .option('--no-wait', 'interrupt active builds and hosted installs');
    command.action(async (opts) => {
      const env = opts.env ?? [];
      const pathPrepend = opts.pathPrepend ?? [];
      const problem = validateServeEnvironment(env, pathPrepend, false);
      if (problem) command.error(problem);
      const { runService } = await loadServerCli();
      await runService(name, { ...opts, 'no-wait': opts.wait === false }, env, pathPrepend);
    });
  }
}
