import { CliUsageError, defineOp, type Op } from '../cli/define-op.ts';
import { loadServerCli } from '../server-cli.ts';
import { DEFAULT_LABEL, validateServeEnvironment } from '@stim-cli/server/service-plist';

async function runService(
  name: string,
  opts: { label?: string; env?: string[]; pathPrepend?: string[] },
): Promise<void> {
  const env = opts.env ?? [];
  const pathPrepend = opts.pathPrepend ?? [];
  const problem = validateServeEnvironment(env, pathPrepend, false);
  if (problem) throw new CliUsageError(problem);
  const { runService: run } = await loadServerCli();
  await run(name, opts, env, pathPrepend);
}

const label = { flags: '--label <name>', description: 'service label' } as const;

const service: Op = defineOp({
  name: 'service',
  description: 'Manage the per-user server service',
  commands: [
    defineOp({
      name: 'install',
      description: '',
      options: {
        label,
        port: { flags: '--port <n>', description: 'server port' },
        serve: { flags: '--serve', description: 'add a tailnet-only Tailscale route' },
        env: { flags: '--env <KEY=VALUE>', description: 'set a server environment variable', repeatable: true },
        pathPrepend: {
          flags: '--path-prepend <dir>',
          description: 'prepend a server tool directory',
          repeatable: true,
        },
      },
      run: ({ options }) => runService('install', options),
    }),
    defineOp({
      name: 'status',
      description: '',
      options: {
        label: { ...label, default: DEFAULT_LABEL },
        json: { flags: '--json', description: 'print status as JSON' },
      },
      run: ({ options }) => runService('status', options),
    }),
    defineOp({
      name: 'uninstall',
      description: '',
      options: { label: { ...label, default: DEFAULT_LABEL } },
      run: ({ options }) => runService('uninstall', options),
    }),
  ],
});

export default service;
