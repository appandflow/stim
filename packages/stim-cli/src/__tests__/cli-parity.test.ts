import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
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
import iosCommand from '../commands/ios.ts';
import androidCommand from '../commands/android.ts';
import reloadCommand from '../commands/reload.ts';
import reviveCommand from '../commands/revive.ts';
import webCommand from '../commands/web.ts';
import macosCommand from '../commands/macos.ts';
import agentDeviceCommand from '../commands/agent-device.ts';
import engineOp from '../commands/engine.ts';
import pairOp from '../commands/pair.ts';
import pairingsCommand from '../commands/pairings.ts';
import serveOp from '../commands/serve.ts';
import serviceOp from '../commands/service.ts';
import setupOp from '../commands/setup.ts';

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
  iosCommand,
  androidCommand,
  reloadCommand,
  reviveCommand,
  webCommand,
  macosCommand,
  engineOp,
  pairOp,
  pairingsCommand,
  serveOp,
  serviceOp,
  setupOp,
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

/** commander 15.0.0's outcome for each row, recorded at 7a95812da by declaring each op through commander's own API. */
const recorded: Record<string, Outcome> = JSON.parse(
  readFileSync(new URL('fixtures/cli-parity.json', import.meta.url), 'utf8'),
);

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
    ['ios'],
    ['ios', '--remote', 'mini'],
    ['ios', '--slot', 'tablet', '--remote', 'mini'],
    ['ios', '--remote-build', 'mini', '--no-build-cache', '--json'],
    [
      'ios',
      '--eas-profile',
      'dev',
      '--slot',
      'phone',
      '--remote-build',
      'auto',
      '--json',
      '--plan',
      '--scheme',
      'App',
      '--no-metro-check',
      '--no-build-cache',
      '--configuration',
      'Release',
      '--device-type',
      'iPad Pro 13-inch (M5)',
      '--runtime',
      '26.0',
      '--install-runtime',
      '--simulator-app',
      'none',
      '--device',
      'UDID',
      '--remote',
      '  mini  ',
      '--wait',
      '30',
    ],
    ['ios', '--device'],
    ['ios', '--device', '--json'],
    ['ios', '--device', '-5'],
    ['ios', '--device=', '--plan'],
    ['ios', '--device', 'UDID', 'extra'],
    ['ios', '--no-wait'],
    ['ios', '--wait', '0'],
    ['ios', '--wait'],
    ['ios', '--wait', '5', '--no-wait'],
    ['ios', '--no-wait', '--wait', '5'],
    ['ios', '--no-wait=1'],
    ['ios', '--metro-check'],
    ['ios', '--slot', 'bad/slot'],
    ['ios', '--slot', 'web'],
    ['ios', '--remote', 'bad name'],
    ['ios', '--remote'],
    ['ios', '--remote-build', ''],
    ['ios', '--remote-build', 'bad name!'],
    ['ios', 'extra'],
    ['ios', '--bogus', '--slot', 'phone'],
    ['ios', '--jsn'],
    ['ios', '-V'],
    ['ios', '--', '--json'],
    ['android'],
    ['android', '--slot', 'tablet', '--remote', 'mini'],
    ['android', '--remote-build', 'mini', '--no-build-cache', '--json'],
    [
      'android',
      '--eas-profile',
      'dev',
      '--variant',
      'productionDebug',
      '--system-image',
      'system-images;android-36;google_apis;arm64-v8a',
      '--device-profile',
      'pixel_fold',
      '--no-metro-check',
      '--plan',
      '--remote',
      '  mini  ',
      '--device',
      '--no-wait',
    ],
    ['android', '--device', 'SERIAL', '--wait', '0'],
    ['android', '--device', '--wat'],
    ['android', '--remote', 'bad name'],
    ['android', '--slot', 'web'],
    ['android', '--wiat', '5'],
    ['android', 'extra'],
    ['reload'],
    ['reload', 'web'],
    ['reload', 'ios', '--json'],
    ['reload', 'bogus'],
    ['reload', 'a', 'b'],
    ['reload', '--jsn'],
    ['revive'],
    ['revive', '--json'],
    ['revive', 'extra'],
    ['web'],
    ['web', '--headed'],
    ['web', '--headed', '--json'],
    ['web', '--headless'],
    ['macos'],
    ['macos', '--remote', 'mini'],
    ['macos', '--plan', '--json', '--remote', 'mini', '--remote-build', 'local'],
    ['macos', '--remote-build', 'bad name!'],
    ['macos', '--remote'],
    ['macos', '--host', 'mini'],
    ['macos', '--no-build-cache'],
    ['engine'],
    ['engine', 'use', '1.2.3', '--channel', 'next'],
    ['engine', 'use'],
    ['engine', 'use', 'a', 'b'],
    ['engine', 'use', '--channel'],
    ['engine', 'rollback', '--restore-state'],
    ['engine', 'status', '--json'],
    ['engine', 'stat'],
    ['engine', 'install', 'x'],
    ['engine', 'help', 'use'],
    ['engine', '--json', 'status'],
    ['pair'],
    ['pair', '--json', '--port', '7787', '--control'],
    ['pair', '--port'],
    ['pair', 'x'],
    ['pair', '--jsn'],
    ['pairings'],
    ['pairings', '--json'],
    ['pairings', '--json', 'list'],
    ['pairings', 'list', '--json'],
    ['pairings', 'log', '--json'],
    ['pairings', '--json', 'log'],
    ['pairings', 'grant', 'ID', '--control'],
    ['pairings', 'grant', 'ID', '--read'],
    ['pairings', 'grant'],
    ['pairings', 'rename', 'ID', 'name'],
    ['pairings', 'rename', 'ID'],
    ['pairings', 'revoke', 'ID'],
    ['pairings', 'help'],
    ['pairings', 'bogus'],
    ['service'],
    [
      'service',
      'install',
      '--port',
      '1',
      '--serve',
      '--env',
      'A=1',
      '--env',
      'B=2',
      '--path-prepend',
      '/x',
      '--label',
      'l',
    ],
    ['service', 'install'],
    ['service', 'status'],
    ['service', 'status', '--json', '--label', 'x'],
    ['service', 'uninstall'],
    ['service', 'instal'],
    ['service', 'status', '--port', '1'],
    ['setup'],
    [
      'setup',
      '--expires',
      '2026-01-01',
      '--build',
      '--device-host',
      '--port',
      '1',
      '--label',
      'l',
      '--env',
      'A=1',
      '--path-prepend',
      '/x',
      '--yes',
      '--json',
      '--verbose',
      '--no-wait',
    ],
    ['setup', '--wait'],
    ['setup', 'x'],
    ['serve'],
    [
      'serve',
      '--port',
      '1',
      '--loopback-only',
      '--share',
      '--tailnet',
      '--service',
      '--env',
      'A=1',
      '--env',
      'B',
      '--path-prepend',
      '/a',
      '--path-prepend',
      '/b',
    ],
    ['serve', '--env'],
    ['serve', 'x'],
    ['serve', '-V'],
    ['serve', '--service=x'],
  ].map((argv) => [argv]),
)('%j parses as commander parsed it', async ([name = '', ...args]) => {
  const op = OPS.find((each) => each.name === name);
  if (!op) throw new Error(`no op named ${name}`);
  expect(await viaDefineOp(op, args)).toEqual(recorded[JSON.stringify([name, ...args])]);
});

test.each([
  [[]],
  [['--help']],
  [['-h']],
  [['--version']],
  [['-V']],
  [['help', 'snapshot']],
  [['--json', 'snapshot', '--slot', 'phone']],
  [['snapshot', '--platform', 'ios', '--', '--json']],
  [['--', '--json']],
  [['agent-device', 'x']],
])('agent-device %j reaches agent-device unchanged', async (args) => {
  let passed: unknown;
  const { out, err } = capture();
  try {
    const code = await runCli({ ...agentDeviceCommand, run: ({ args: given }) => void (passed = given) }, args, {
      version: '9.9.9',
    });
    expect(code).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
  expect(passed).toEqual(args);
  expect([out.join(''), err.join('')]).toEqual(['', '']);
});

test('help agent-device prints its usage instead of running it', async () => {
  let ran = false;
  const { out } = capture();
  try {
    await runCli({ ...agentDeviceCommand, run: () => void (ran = true) }, ['--help', 'snapshot'], {
      version: '9.9.9',
      help: true,
    });
  } finally {
    vi.restoreAllMocks();
  }
  expect(ran).toBe(false);
  expect(out.join('')).toMatch(/^Usage: stim agent-device \[args\.\.\.\]\n/);
});
