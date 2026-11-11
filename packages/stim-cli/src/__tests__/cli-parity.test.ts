import { afterEach, expect, test, vi } from 'vitest';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { CliUsageError, runCli, type Op } from '../cli/define-op.ts';
import deviceCommand from '../commands/device.ts';
import doctorCommand from '../commands/doctor.ts';
import gcOp from '../commands/gc.ts';
import guideCommand from '../commands/guide.ts';
import logsOp from '../commands/logs.ts';
import portsOp from '../commands/ports.ts';
import remoteCommand from '../commands/remote.ts';
import settingsCommand from '../commands/settings.ts';
import shareCommand from '../commands/share.ts';
import statsOp from '../commands/stats.ts';
import startCommand from '../commands/start.ts';
import statusOp from '../commands/status.ts';
import stopOp from '../commands/stop.ts';
import worktreeOp from '../commands/worktree.ts';

const OPS = [
  statusOp,
  statsOp,
  settingsCommand,
  guideCommand,
  portsOp,
  remoteCommand,
  logsOp,
  doctorCommand,
  gcOp,
  deviceCommand,
  shareCommand,
  startCommand,
  stopOp,
  worktreeOp,
];

interface Outcome {
  ran?: { path: string[]; args: unknown[]; options: unknown; parent: unknown };
  error?: string;
  out: string;
  err: string;
  exitCode: number;
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => out.push(String(chunk)) > 0);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => err.push(String(chunk)) > 0);
  return { out, err };
}

function spy(op: Op, path: string[], ran: (outcome: Outcome['ran']) => void): Op {
  const here = [...path, op.name];
  return {
    ...op,
    commands: op.commands.map((sub) => spy(sub, here, ran)),
    run: op.run && (({ args, options, parent }) => ran({ path: here, args: [...args], options, parent })),
  };
}

function declare(parent: Command, op: Op, path: string[], ran: (outcome: Outcome['ran']) => void): void {
  const here = [...path, op.name];
  const described = Object.keys(op.argumentDescriptions).length > 0;
  const command = parent
    .command([op.name, ...(described ? [] : [op.arguments])].filter(Boolean).join(' '))
    .description(op.description);
  if (described)
    for (const arg of op.arguments.split(' ')) command.argument(arg, op.argumentDescriptions[arg.slice(1, -1)]);
  if (op.positionalOptions) {
    parent.enablePositionalOptions();
    command.enablePositionalOptions();
  }
  for (const option of Object.values(op.options)) {
    const add = option.mandatory ? command.requiredOption.bind(command) : command.option.bind(command);
    const { parse } = option;
    if (parse)
      add(option.flags, option.description, (value: string) => {
        try {
          return parse(value);
        } catch (error) {
          throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
        }
      });
    else add(option.flags, option.description);
  }
  for (const sub of op.commands) declare(command, sub, here, ran);
  if (op.run)
    command.action((...params: unknown[]) => {
      const self = params.at(-1);
      if (!(self instanceof Command)) throw new Error('commander passed no command');
      const args = [...self.processedArgs];
      while (args.length && args.at(-1) === undefined) args.pop();
      ran({ path: here, args, options: self.opts(), parent: here.length > 1 ? (self.parent?.opts() ?? {}) : {} });
    });
}

async function viaCommander(op: Op, args: string[]): Promise<Outcome> {
  const outcome: Outcome = { out: '', err: '', exitCode: 0 };
  const out: string[] = [];
  const err: string[] = [];
  const program = new Command()
    .name('stim')
    .version('9.9.9')
    .exitOverride()
    .configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => err.push(text) });
  declare(program, op, [], (ran) => (outcome.ran = ran));
  try {
    await program.parseAsync(['node', 'stim', op.name, ...args]);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    outcome.exitCode = error.exitCode;
    if (!['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(error.code)) {
      outcome.error = error.message;
      err.length = 0;
    }
  }
  return { ...outcome, out: out.join(''), err: err.join('') };
}

async function viaDefineOp(op: Op, args: string[]): Promise<Outcome> {
  const outcome: Outcome = { out: '', err: '', exitCode: 0 };
  const { out, err } = capture();
  try {
    outcome.exitCode = await runCli(
      spy(op, [], (ran) => (outcome.ran = ran)),
      args,
      { version: '9.9.9' },
    );
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    outcome.error = error.message;
    outcome.exitCode = 1;
  } finally {
    vi.restoreAllMocks();
  }
  return { ...outcome, out: out.join(''), err: err.join('') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test.each(
  [
    ...OPS.flatMap((op) => [[op.name, '--help'], ...op.commands.map((sub) => [op.name, sub.name, '--help'])]),
    ['status', '--json'],
    ['status', '--watch', '--json', '--fresh'],
    ['status', '--jso'],
    ['status', '--json=true'],
    ['status', '--bogus', '--help'],
    ['status', 'extra', 'more'],
    ['status', '-V'],
    ['status', '-abc'],
    ['status', '--', '--json'],
    ['status', '-5'],
    ['stats', '--json'],
    ['settings'],
    ['settings', '--json'],
    ['settings', 'bogus'],
    ['settings', 'help', 'get'],
    ['settings', '--help', 'get'],
    ['settings', '--json', 'get', 'idle.minutes'],
    ['settings', 'get', 'idle.minutes', '--json', '--scope', 'machine'],
    ['settings', 'get'],
    ['settings', 'get', 'k', '--scope'],
    ['settings', 'get', 'k', '--scop', 'x'],
    ['settings', '--bogus', 'get', 'k'],
    ['settings', 'set', 'idle.minutes', '-1', '--scope', 'machine'],
    ['settings', 'set', 'workspace.hidden', 'true', '--scope', 'workspace'],
    ['settings', 'unset', 'idle.minutes', '--scope=machine', '--json'],
    ['settings', '--', 'get', 'idle.minutes', '--json'],
    ['settings', '--', 'set', 'idle.minutes', '45', '--scope', 'machine'],
    ['guide'],
    ['guide', 'errors', 'STIM_NO_METRO'],
    ['guide', 'a', 'b', 'c'],
    ['guide', '--', '--version'],
    ['guide', '--bogus'],
    ['ports'],
    ['ports', '--json'],
    ['ports', '--json', 'get', 'api'],
    ['ports', 'get', 'api', '--json'],
    ['ports', '--', 'get', 'api', '--json'],
    ['ports', '--version'],
    ['ports', '--jsn'],
    ['ports', 'stop', 'api', '--dry-run'],
    ['ports', 'stop', 'api', '--dry'],
    ['ports', 'release'],
    ['ports', 'reverse', '8081', '--remove', '--json'],
    ['ports', 'help', 'get'],
    ['remote'],
    ['remote', 'ad'],
    ['remote', 'help'],
    ['remote', 'help', 'add'],
    ['remote', 'help', 'bogus'],
    ['remote', '--bogus', 'add'],
    ['remote', 'add', 'mini', '--json'],
    ['remote', 'add', 'a', 'b'],
    ['remote', 'update', 'mini', '--channel', 'next'],
    ['remote', 'update', 'mini', '--channel'],
    ['remote', 'list', '--json'],
    ['remote', 'remove', 'mini', '--json'],
    ['remote', '-V'],
    ['logs', '--errors'],
    ['logs', '--slot', 'phone', '--json', '--follow'],
    ['logs', '--slot', 'bad/slot', '--help'],
    ['logs', '--bogus', '--slot', 'web'],
    ['logs', '--slot'],
    ['logs', '--source', 'metro', 'client', '--json'],
    ['logs', '--source', 'metro', '--source', 'client'],
    ['logs', '--source=metro', 'client'],
    ['logs', '--source', 'gc', '--tail', '-5'],
    ['logs', '--grep', '--json'],
    ['logs', '--level', 'warn', '--since', '5m', '--tail', '20'],
    ['logs', '--sorce', 'metro'],
    ['doctor', '--json'],
    ['doctor', '--fix', '--platform=ios'],
    ['doctor', '--platform', 'web'],
    ['doctor', '--platform'],
    ['doctor', '--jsn'],
    ['doctor', 'extra'],
    ['doctor', '--', '--json'],
    ['gc'],
    ['gc', '--json', '--delete', '--cache', 'workspaces'],
    ['gc', '--delete', '--cache', 'archived:x'],
    ['gc', '--older-than', '30', '--worktrees', '--json'],
    ['gc', '--older-than', 'lastweek'],
    ['gc', '--older-than=-5'],
    ['gc', '--cache', '  '],
    ['gc', '--cache'],
    ['gc', '--delet'],
    ['device'],
    ['device', 'help'],
    ['device', 'help', 'push'],
    ['device', 'lok'],
    ['device', '-V'],
    ['device', '--json', 'lock', 'ios'],
    ['device', 'lock'],
    ['device', 'lock', 'ios', 'ID', '--for', '30s', '--wait', '0', '--json', '--slot', 'x'],
    ['device', 'lock', 'ios', '--slot', 'bad/slot'],
    ['device', 'lock', 'ios', 'a', 'b'],
    ['device', '--', 'lock', 'ios', '--json'],
    ['device', 'lock', '--', 'ios', '--json'],
    ['device', 'unlock'],
    ['device', 'unlock', 'android', '--json'],
    ['device', 'provision', 'ios', '--yes', '--scheme', 'App', '--configuration', 'Debug'],
    ['device', 'location', 'ios', '--set', '45.5,-73.6', '--json'],
    ['device', 'location', 'ios', '--clear'],
    ['device', 'permission', 'ios', 'grant'],
    ['device', 'permission', 'ios', 'grant', 'camera', '--json'],
    ['device', 'push', 'ios'],
    ['device', 'push', 'ios', '--bogus'],
    ['device', 'push', 'ios', 'extra'],
    ['device', 'push', 'ios', '--help'],
    ['device', 'push', 'ios', '--payload'],
    ['device', 'push', 'ios', '--payload', '{"aps":{}}', '--slot', 'phone'],
    ['device', 'network', 'android', 'off'],
    ['share'],
    ['share', 'list', '--json'],
    ['share', 'stop', '--forget'],
    ['share', 'ios', 'extra'],
    ['share', 'ios', '--slug', 'demo', '--expires', '30', '--reuse', '--device', '--slot', 'phone'],
    ['share', 'ios', '--password', 'secret12', '--no-password'],
    ['share', 'ios', '--no-password', '--password', 'secret12'],
    ['share', 'ios', '--no-password=x'],
    ['share', 'ios', '--control', '--view-password'],
    ['share', 'ios', '--view-password', 'viewer12', '--control'],
    ['share', 'ios', '--view-password', '--json'],
    ['share', 'ios', '--view-password', '-5'],
    ['share', 'ios', '--view-password', '-'],
    ['share', 'ios', '--view-password', '--', 'x'],
    ['share', 'ios', '--view-password='],
    ['share', 'ios', '--view-password=abc'],
    ['share', '--view-password', 'ios'],
    ['share', '--passwrd', 'x', 'ios'],
    ['share', '--', 'ios', '--json'],
    ['start'],
    ['start', '--json', '--wait', '30', '--remote', '--reset-cache'],
    ['start', '--wait'],
    ['start', 'extra'],
    ['start', '--bogus'],
    ['stop'],
    ['stop', '--slot', 'tablet', '--json'],
    ['stop', '--slot', 'web'],
    ['stop', '--slot', 'bad/slot'],
    ['stop', '--slot'],
    ['worktree'],
    ['worktree', 'warm'],
    ['worktree', 'warm', '--refresh'],
    ['worktree', 'warm', 'extra'],
    ['worktree', 'remove'],
    ['worktree', 'remove', '../wt', '--force'],
    ['worktree', 'remove', 'a', 'b'],
    ['worktree', 'help', 'remove'],
    ['worktree', 'bogus'],
  ].map((argv) => [argv]),
)('%j parses as commander parsed it', async ([name = '', ...args]) => {
  const op = OPS.find((each) => each.name === name);
  if (!op) throw new Error(`no op named ${name}`);
  expect(await viaDefineOp(op, args)).toEqual(await viaCommander(op, args));
});
