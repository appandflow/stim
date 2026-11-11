import { CliUsageError, defineOp, type Op } from '../cli/define-op.ts';
import { loadServerCli } from '../server-cli.ts';
import { DEFAULT_PORT } from '@stim-cli/server/service-plist';

const pairOp: Op = defineOp({
  name: 'pair',
  description: 'Print a single-use pairing payload',
  options: {
    port: { flags: '--port <n>', description: 'server port', default: String(DEFAULT_PORT) },
    control: { flags: '--control', description: 'allow the paired device to run actions' },
    json: { flags: '--json', description: 'print pairing data as JSON' },
  },
  async run({ options: opts }) {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new CliUsageError(`--port must be a port number, got ${opts.port}.`);
    const { pair } = await loadServerCli();
    await pair(port, opts.json === true, opts.control === true);
    const { ensureNet, stimdRefused } = await import('../daemon/client.ts');
    const answer = await ensureNet(false);
    if (!answer && stimdRefused())
      console.error(
        "This Stim home's stimd runs another Stim build, so this stim cannot check that its server listens. The pairing is saved, and that server takes it if it listens.",
      );
    else if (!answer) console.error('No stimd runs to take this pairing; run stim serve.');
    else if (!answer.listening) console.error(answer.message);
    else if (answer.port !== port)
      console.error(
        `stimd's server listens on port ${answer.port}, not ${port}; pair again with --port ${answer.port}.`,
      );
  },
});

export default pairOp;
