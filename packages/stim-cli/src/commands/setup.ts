import { defineOp, type Op } from '../cli/define-op.ts';
import { loadServerCli } from '../server-cli.ts';

const setupOp: Op = defineOp({
  name: 'setup',
  description: 'Approve the machine holding STIM_SETUP_TICKET on this worker',
  options: {
    expires: { flags: '--expires <iso>', description: 'approval expiry' },
    build: { flags: '--build', description: 'approve builds' },
    deviceHost: { flags: '--device-host', description: 'approve hosted devices' },
    test: { flags: '--test', description: 'approve running any command it sends, no sandbox' },
    port: { flags: '--port <n>', description: 'server port' },
    label: { flags: '--label <name>', description: 'service label' },
    env: { flags: '--env <KEY=VALUE>', description: 'set a server environment variable' },
    pathPrepend: { flags: '--path-prepend <dir>', description: 'prepend a server tool directory' },
    yes: { flags: '--yes', description: 'approve without a terminal prompt' },
    json: { flags: '--json', description: 'print the result as JSON' },
    verbose: { flags: '--verbose', description: 'print setup details' },
    wait: { flags: '--no-wait', description: 'interrupt active builds and hosted installs' },
  },
  async run() {
    const { setup } = await loadServerCli();
    await setup(process.argv.slice(3));
  },
});

export default setupOp;
