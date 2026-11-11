import { defineOp, type Op } from '../cli/define-op.ts';
import { loadServerCli } from '../server-cli.ts';

const json = { flags: '--json', description: 'print pairings as JSON' };

/** `stim-server`'s `log` subcommand at its root; `stim pairings log` under `pairings`. */
export const log: Op = defineOp({
  name: 'log',
  description: 'List the actions paired devices ran',
  options: { json: { flags: '--json', description: 'print actions as JSON' } },
  async run({ options, parent }) {
    const { logActions } = await loadServerCli();
    logActions(parent.json === true || options.json === true);
  },
});

/** `stim pairings`, or `stim-server devices` without `log`. */
export function pairingsOp(name: string, commands: readonly Op[]): Op {
  return defineOp({
    name,
    description: 'Manage paired devices, approved clients and hosted sessions',
    options: { json },
    async run({ options }) {
      const { listPairings } = await loadServerCli();
      listPairings(options.json === true);
    },
    commands: [
      defineOp({
        name: 'list',
        description: '',
        options: { json },
        async run({ options, parent }) {
          const { listPairings } = await loadServerCli();
          listPairings(parent.json === true || options.json === true);
        },
      }),
      defineOp({
        name: 'grant',
        description: '',
        arguments: '<id>',
        options: {
          control: { flags: '--control', description: 'allow actions' },
          read: { flags: '--read', description: 'allow only reading' },
        },
        async run({ args: [id], options }) {
          const { grant } = await loadServerCli();
          grant(id, options);
        },
      }),
      defineOp({
        name: 'revoke',
        description: '',
        arguments: '<id>',
        async run({ args: [id] }) {
          const { revoke } = await loadServerCli();
          revoke(id);
        },
      }),
      defineOp({
        name: 'rename',
        description: '',
        arguments: '<id> <name>',
        async run({ args: [id, newName] }) {
          const { rename } = await loadServerCli();
          rename(id, newName);
        },
      }),
      ...commands,
    ],
  });
}

const pairings: Op = pairingsOp('pairings', [log]);

export default pairings;
