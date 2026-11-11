import type { NetAnswer } from '../daemon/client.ts';
import type { ServeOptions } from '../stimd/main.ts';
import { bundledStim } from '@stim-cli/server/environment';
import { DEFAULT_PORT, validateServeEnvironment } from '@stim-cli/server/service-plist';
import { CliUsageError, defineOp, runCli, type Op } from '../cli/define-op.ts';
import pairOp from './pair.ts';
import { log, pairingsOp } from './pairings.ts';
import serviceOp from './service.ts';
import { loadServerCli } from '../server-cli.ts';
import setupOp from './setup.ts';

const options = {
  port: { flags: '--port <n>', description: 'server port', default: String(DEFAULT_PORT) },
  loopbackOnly: { flags: '--loopback-only', description: 'serve this machine only' },
  share: { flags: '--share', description: 'serve web shares until the last share ends' },
  tailnet: {
    flags: '--tailnet',
    description: 'listen on the tailnet from now on, without waiting for a pairing or approval',
  },
  service: { flags: '--service', description: '', hidden: true },
  env: { flags: '--env <KEY=VALUE>', description: 'set a server environment variable', repeatable: true },
  pathPrepend: { flags: '--path-prepend <dir>', description: 'prepend a server tool directory', repeatable: true },
} as const;

const serveOp = defineOp({
  name: 'serve',
  description: 'Serve paired clients',
  options,
  async run({ options: opts }) {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new CliUsageError(`--port must be a port number, got ${opts.port}.`);
    const problem = validateServeEnvironment(opts.env, opts.pathPrepend, true);
    if (problem) throw new CliUsageError(problem);
    if (opts.tailnet === true) {
      const narrower = opts.share === true ? '--share' : opts.loopbackOnly === true ? '--loopback-only' : null;
      if (narrower) {
        console.error(
          `stim-server: STIM_BAD_ARG: --tailnet listens on the tailnet, and ${narrower} serves this machine only. Pass one of them.`,
        );
        process.exitCode = 1;
        return;
      }
      const note = await (await loadServerCli()).rememberTailnet();
      if (note) console.error(`stim-server: ${note}`);
    }
    await serveInStimd({
      port,
      extraEnv: opts.env,
      pathPrepend: opts.pathPrepend,
      loopbackOnly: opts.loopbackOnly === true || opts.share === true,
      shareOnly: opts.share === true,
    });
  },
});

const stimServe: Op = { ...serveOp, version: true };
export default stimServe;

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

function positional(op: Op): Op {
  return { ...op, positionalOptions: true };
}

export async function legacyMain(): Promise<void> {
  const program: Op = {
    ...serveOp,
    name: 'stim-server',
    description: '',
    version: true,
    positionalOptions: true,
    commands: [pairOp, pairingsOp('devices', []), log, serviceOp, setupOp].map(positional),
  };
  try {
    const code = await runCli(program, process.argv.slice(2), { version: bundledStim().version, root: true });
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    const scope = /unknown option '(--(?:build|device-host))'/.exec(error.message);
    process.stderr.write(
      scope
        ? `stim-server: ${scope[1]} applies only to \`stim setup\`, which a person runs on this machine with the requesting machine's setup ticket.\n`
        : `${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
