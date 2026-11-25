import { processContext } from '../cli-operation.ts';
import { helperCommand, helperStatus } from '../apple-services.ts';
import { CliUsageError, defineOp, type Op } from '../cli/define-op.ts';
import { loadServerCli } from '../server-cli.ts';
import { DEFAULT_LABEL, validateServeEnvironment } from '@stim-cli/server/service-plist';

async function runService(
  name: string,
  opts: { label?: string; env?: string[]; pathPrepend?: string[]; helper?: boolean; port?: string; serve?: boolean },
): Promise<void> {
  if (opts.helper) {
    if (
      opts.label !== undefined ||
      opts.port !== undefined ||
      opts.serve ||
      opts.env?.length ||
      opts.pathPrepend?.length
    )
      throw new CliUsageError(
        '--helper cannot be combined with server service options. Run the helper command separately.',
      );
    const state = await helperCommand(name === 'install' ? 'register' : 'unregister');
    processContext('').output(
      'stdout',
      `Runaway service helper: ${state}${state === 'requires approval' ? '; approve Stim Host in System Settings > General > Login Items & Extensions' : ''}\n`,
    );
    return;
  }
  const env = opts.env ?? [];
  const pathPrepend = opts.pathPrepend ?? [];
  const problem = validateServeEnvironment(env, pathPrepend, false);
  if (problem) throw new CliUsageError(problem);
  const { runService: run } = await loadServerCli();
  const { helper: _helper, ...serverOptions } = opts;
  await run(
    name,
    { ...serverOptions, ...(name === 'status' ? { helper: await helperStatus() } : {}) },
    env,
    pathPrepend,
  );
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
        helper: {
          flags: '--helper',
          description: 'install Stim Host and register only the macOS runaway service helper',
        },
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
      options: {
        label,
        helper: { flags: '--helper', description: 'unregister the macOS runaway service helper only' },
      },
      run: ({ options }) => runService('uninstall', options),
    }),
  ],
});

export default service;
