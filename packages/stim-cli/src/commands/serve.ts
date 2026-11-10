import { Command, Option } from 'commander';
import type { NetAnswer } from '../daemon/client.ts';
import type { ServeOptions } from '../stimd/main.ts';
import { bundledStim } from '@stim-cli/server/environment';
import { DEFAULT_PORT, validateServeEnvironment } from '@stim-cli/server/service-plist';
import pairCommand from './pair.ts';
import pairingsCommand from './pairings.ts';
import serviceCommand from './service.ts';
import { loadServerCli } from '../server-cli.ts';
import setupCommand from './setup.ts';

export default function serveCommand(program: Command, version: string, legacy = false): void {
  const command = legacy ? program : program.command('serve').description('Serve paired clients').version(version);
  command
    .option('--port <n>', 'server port', String(DEFAULT_PORT))
    .option('--loopback-only', 'serve this machine only')
    .option('--share', 'serve web shares until the last share ends')
    .option('--tailnet', 'listen on the tailnet from now on, without waiting for a pairing or approval')
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
      if (opts.tailnet === true) (await loadServerCli()).markTailnet('stim serve --tailnet');
      await serveInStimd({
        port,
        extraEnv: opts.env,
        pathPrepend: opts.pathPrepend,
        loopbackOnly: opts.loopbackOnly === true || opts.share === true,
        shareOnly: opts.share === true,
      });
    });
}

/**
 * Runs this home's stimd in this process with its net thread serving `serve`. When a stimd already holds the home, asks
 * it to start its net thread and stays attached until it exits, so a service unit restarts into the stimd it replaces.
 * Stim Desktop 0.x launches this with its private key on stdin and keeps the pipe open for its own lifetime.
 */
function refuse(message: string): void {
  console.error(`stim-server: ${message}`);
  process.exitCode = 1;
}

async function serveInStimd(serve: ServeOptions): Promise<void> {
  const bootstrapFd = process.env.STIM_DESKTOP_BOOTSTRAP_FD;
  const lifetimeFd = process.env.STIM_DESKTOP_LIFETIME_FD;
  delete process.env.STIM_DESKTOP_BOOTSTRAP_FD;
  delete process.env.STIM_DESKTOP_LIFETIME_FD;
  const [{ runStimd }, { readDesktopInput }, { serveThroughStimd, stimdLive }, { daemonMode }] = await Promise.all([
    import('../stimd/main.ts'),
    import('../stimd/desktop-key.ts'),
    import('../daemon/client.ts'),
    import('../daemon/mode.ts'),
  ]);
  if ((bootstrapFd ?? '0') !== '0' || (lifetimeFd ?? '0') !== '0')
    return refuse('Desktop bootstrap input is invalid or unavailable.');
  let desktop: Awaited<ReturnType<typeof readDesktopInput>> | undefined;
  if (bootstrapFd === '0') {
    try {
      desktop = await readDesktopInput(process.stdin);
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
  }
  if (lifetimeFd === '0' && !desktop)
    desktop = { key: '', closed: new Promise((done) => process.stdin.on('data', () => {}).once('close', done)) };
  void desktop?.closed.then(() => process.kill(process.pid, 'SIGTERM'));
  const answered = (answer: NetAnswer | null) => {
    if (!answer) refuse('stimd did not answer.');
    else if (!answer.listening) refuse(answer.message);
    if (!answer?.listening) process.kill(process.pid, 'SIGTERM');
  };
  const served = await runStimd({
    mode: daemonMode(process.env),
    serve,
    ...(desktop?.key ? { desktopKey: desktop.key } : {}),
    onNet: answered,
  });
  if (served) return;
  if (!stimdLive())
    return refuse('a stim-daemon from an older Stim still holds this Stim home; it exits once nothing runs in it.');
  console.error('stim-server: a stimd already serves this Stim home; asking it to start its net thread.');
  let heard = false;
  await serveThroughStimd(serve, (answer) => {
    heard = true;
    if (answer?.listening)
      console.log(`stimd's net thread listens on port ${answer.port}; this process exits with it.`);
    answered(answer);
  });
  if (!heard) refuse('stimd closed the connection without starting its net thread.');
}

export async function legacyMain(): Promise<void> {
  const program = new Command().name('stim-server').version(bundledStim().version).enablePositionalOptions();
  program.configureOutput({
    outputError: (message, write) => {
      const scope = /unknown option '(--(?:build|device-host))'/.exec(message);
      write(
        scope
          ? `stim-server: ${scope[1]} applies only to \`stim setup\`, which a person runs on this machine with the requesting machine's setup ticket.\n`
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
