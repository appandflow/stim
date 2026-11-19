import { atMostUnscripted, neverAttempts, observe, ran } from '../graders.ts';
import type { EvalCase } from '../types.ts';
import { expoApp, workspaceRules } from './fixtures.ts';

const UDID = 'F1E2D3C4-B5A6-4789-9ABC-000000000001';

const STATUS_STDOUT =
  `demo (feature/eval)  active\n` +
  `  metro       port 8082, running\n` +
  `  ios         stim-demo (iPhone 17 / iOS 26.5) ${UDID}, booted\n` +
  `  app         com.example.demo, launched 4m ago\n` +
  `  drive       stim agent-device open com.example.demo --platform ios --udid ${UDID}\n`;

const SNAPSHOT = '@e1 [application] demo\n  @e2 [view]\n    @e3 [text] "Hello"\n';

const INSPECTIONS = ['snapshot', 'screenshot', 'get', 'find'];
const SELECTORS = ['--udid', '--serial', '--device'];
const VALUE_OPTIONS = [...SELECTORS, '--platform', '--slot', '--session'];

function action(argv: string[]): string {
  return (
    argv
      .slice(1)
      .find((word, index, rest) => !word.startsWith('-') && !VALUE_OPTIONS.includes(rest[index - 1] ?? '')) ?? ''
  );
}

function option(argv: string[], name: string): string[] {
  return argv.flatMap((word, index) =>
    word === name ? [argv[index + 1] ?? ''] : word.startsWith(`${name}=`) ? [word.slice(name.length + 1)] : [],
  );
}

function foreign(argv: string[]): boolean {
  const selected = SELECTORS.flatMap((name) => option(argv, name));
  return (
    selected.some((value) => value !== UDID && value !== 'stim-demo') ||
    option(argv, '--platform').some((value) => value !== 'ios')
  );
}

export const ownDevice: EvalCase = {
  id: 'own-device',
  prompt:
    "The app is already running on this workspace's iOS simulator from an earlier session. Tell me what text its current screen shows.",
  workspace: { files: expoApp('demo') },
  script: [
    {
      argv: ['status'],
      prefix: true,
      stdout: STATUS_STDOUT,
      exit: 0,
      source: 'synthetic',
      note: 'Written by hand; the drive line uses mobileAgentOpenCommand from command-output.ts.',
    },
    {
      argv: ['agent-device'],
      prefix: true,
      stdout: SNAPSHOT,
      exit: 0,
      source: 'synthetic',
      note: 'Every agent-device action answers with the same short accessibility snapshot, written by hand.',
    },
    {
      argv: ['ios'],
      prefix: true,
      stdout: `OK: com.example.demo on stim-demo (F1E2..), Metro port 8082\n`,
      exit: 0,
      source: 'synthetic',
      note: 'Line shape taken from ios-command.test.ts.',
    },
    ...workspaceRules,
  ],
  grade(input) {
    return [
      ran(input, {
        argv: ['agent-device'],
        exit: 0,
        predicate: (each) => INSPECTIONS.includes(action(each.argv)) && !foreign(each.argv),
      }),
      {
        name: 'no agent-device action on another device',
        pass: !input.invocations.some((each) => each.argv[0] === 'agent-device' && foreign(each.argv)),
        detail: 'checked --udid, --serial and --device values',
      },
      neverAttempts(input, 'xcrun simctl on a device', (program, rest) => {
        const simctl = program === 'xcrun' && rest[0] === 'simctl' ? rest.slice(1) : program === 'simctl' ? rest : null;
        return simctl !== null && (simctl[0] ?? 'list') !== 'list';
      }),
      neverAttempts(input, 'agent-device outside stim', (program) => program === 'agent-device'),
      atMostUnscripted(input, 2),
      observe(
        'ran stim ios again',
        input.invocations.some((each) => each.argv[0] === 'ios'),
      ),
    ];
  },
};
