import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atMostUnscripted,
  exitedBefore,
  guideBytes,
  IOS_LAUNCH,
  matches,
  observe,
  ran,
  ranAfter,
  type Match,
} from '../graders.ts';
import { REPO_ROOT } from '../trial.ts';
import type { EvalCase, GradeInput, Invocation, ScriptRule } from '../types.ts';
import { expoApp, workspaceRules } from './fixtures.ts';

function websitePrompt(page: string, title: string): string {
  const source = readFileSync(join(REPO_ROOT, 'website/docs', `${page}.md`), 'utf8');
  const boxes = [...source.matchAll(/<PromptBox\b[\s\S]*?<\/PromptBox>/g)].filter(([box]) =>
    box.includes(`title="${title}"`),
  );
  if (boxes.length !== 1) throw new Error(`expected one website prompt titled ${title} in ${page}.md`);
  const box = boxes[0]![0];
  const prompt = box.slice(box.indexOf('>') + 1).match(/\{`([^`]+)`\}/)?.[1];
  if (!prompt || prompt.includes('${')) throw new Error(`unsupported prompt syntax: ${title}`);
  return prompt;
}

function flag(argv: string[], name: string): string | true | undefined {
  for (const [index, word] of argv.entries()) {
    if (word.startsWith(`${name}=`)) return word.slice(name.length + 1);
    if (word === name) {
      const next = argv[index + 1];
      return next === undefined || next.startsWith('-') ? true : next;
    }
  }
  return undefined;
}

const IOS_OK: ScriptRule = {
  argv: ['ios'],
  prefix: true,
  stdout: 'OK: com.example.demo on stim-demo (BF2A..), Metro port 8082\n',
  exit: 0,
  source: 'synthetic',
  note: 'Line shape taken from the expectation in ios-command.test.ts; the app and device names are invented.',
};

const NO_ERRORS: ScriptRule = {
  argv: ['logs'],
  prefix: true,
  stderr: 'No matching log records\n',
  exit: 0,
  source: 'synthetic',
  note: 'The zero-match human output the guide describes.',
};

const LOGS_ERRORS: Match = { argv: ['logs'], predicate: (each) => each.argv.includes('--errors') };

function guided(input: GradeInput, action: Match): ReturnType<typeof ran>[] {
  return [
    ran(input, action),
    exitedBefore(input, { argv: ['guide'] }, action),
    atMostUnscripted(input, 2),
    observe('guide bytes read', guideBytes(input.invocations)),
  ];
}

function launches(input: GradeInput): Invocation[] {
  return input.invocations.filter((each) => matches(each, IOS_LAUNCH));
}

const simulator: EvalCase = {
  id: 'website-simulator',
  prompt: websitePrompt('getting-started', 'Choose an iOS simulator'),
  workspace: { files: expoApp('demo') },
  script: [...workspaceRules, IOS_OK],
  grade(input) {
    return guided(input, {
      ...IOS_LAUNCH,
      predicate: (each) =>
        IOS_LAUNCH.predicate!(each) &&
        flag(each.argv, '--device-type') === 'iPhone 17' &&
        String(flag(each.argv, '--runtime')).includes('26.5') &&
        flag(each.argv, '--device') === undefined,
    });
  },
};

const phone: EvalCase = {
  id: 'website-phone',
  prompt: websitePrompt('getting-started', 'Run on a connected phone'),
  workspace: { files: expoApp('demo') },
  script: [...workspaceRules, IOS_OK],
  grade(input) {
    return guided(input, {
      ...IOS_LAUNCH,
      predicate: (each) =>
        IOS_LAUNCH.predicate!(each) &&
        flag(each.argv, '--device') !== undefined &&
        flag(each.argv, '--device-type') === undefined,
    });
  },
};

const recentErrors: EvalCase = {
  id: 'website-logs',
  prompt: websitePrompt('getting-started', 'Inspect recent errors'),
  workspace: { files: expoApp('demo') },
  script: [...workspaceRules, NO_ERRORS],
  grade(input) {
    return guided(input, {
      ...LOGS_ERRORS,
      predicate: (each) => LOGS_ERRORS.predicate!(each) && flag(each.argv, '--since') === '10m',
    });
  },
};

const WORKTREE_CONTEXT =
  ' The change: in App.tsx, replace the text Hello with Hello, Stim. Create the worktree under .worktrees/ in this checkout.';

const separateWorktree: EvalCase = {
  id: 'website-worktree',
  prompt: websitePrompt('getting-started', 'Work in parallel') + WORKTREE_CONTEXT,
  workspace: { files: expoApp('demo') },
  script: [...workspaceRules, IOS_OK, NO_ERRORS],
  grade(input) {
    const inPlace = input.invocations.filter(
      (each) => each.cwdRelative === '.' && (matches(each, IOS_LAUNCH) || matches(each, { argv: ['start'] })),
    );
    return [
      ...guided(input, { argv: ['worktree', 'warm'], exit: 0, predicate: (each) => each.cwdRelative !== '.' }),
      exitedBefore(input, { argv: ['worktree', 'warm'] }, IOS_LAUNCH),
      {
        name: 'no stim start or ios in the original checkout',
        pass: inPlace.length === 0,
        detail: `${inPlace.length} matching invocations`,
      },
    ];
  },
};

const SLOTS = ['phone', 'tablet', 'hardware'];

const slots: EvalCase = {
  id: 'website-slots',
  prompt: websitePrompt('owned-devices', 'Test a change on multiple devices'),
  workspace: { files: expoApp('demo') },
  script: [...workspaceRules, IOS_OK, NO_ERRORS],
  grade(input) {
    const launched = (slot: string) =>
      launches(input).filter((each) => flag(each.argv, '--slot') === slot && each.exitCode === 0);
    const wrong = launches(input).filter((each) => {
      const slot = flag(each.argv, '--slot');
      const device = flag(each.argv, '--device') !== undefined;
      const model = String(flag(each.argv, '--device-type') ?? '');
      if (slot === 'hardware') return !device || model !== '';
      if (slot === 'tablet') return device || !model.includes('iPad');
      if (slot === 'phone') return device || model.includes('iPad');
      return true;
    });
    const stops = input.invocations.filter((each) => matches(each, { argv: ['stop'] }));
    return [
      ...SLOTS.map((slot) => ({
        name: `launched the ${slot} slot`,
        pass: launched(slot).length > 0,
        detail: `${launched(slot).length} matching invocations`,
      })),
      {
        name: 'every launch names a slot with its target: phone simulator, iPad simulator, connected device',
        pass: wrong.length === 0,
        detail: wrong.map((each) => each.argv.join(' ')).join(' | ') || 'none',
      },
      { name: 'left the devices running', pass: stops.length === 0, detail: `${stops.length} stim stop` },
      exitedBefore(input, { argv: ['guide'] }, IOS_LAUNCH),
      atMostUnscripted(input, 2),
      observe('ran stim logs --errors after a launch', ranAfter(input, IOS_LAUNCH, LOGS_ERRORS).pass),
      observe('guide bytes read', guideBytes(input.invocations)),
    ];
  },
};

const LAUNCH_FAILED_STDERR =
  '  build       cache hit (local) 4.1s\n' +
  '  install     com.example.demo on stim-demo (iPhone 17 / iOS 26.5)\n' +
  '  error       STIM_LAUNCH_FAILED: The app failed its launch readiness check.\n' +
  '  remedy      Read the launch error above or run `stim logs --errors`.\n';

const LAUNCH_ERROR_LOG =
  "14:03:54.210 error metro  ERROR  TypeError: Cannot read property 'title' of undefined\n" +
  '    This error is located at:\n' +
  '        in SettingsScreen (at App.tsx:12)\n';

const failedLaunch: EvalCase = {
  id: 'website-failure',
  prompt: websitePrompt('getting-started', 'Build and run'),
  workspace: { files: expoApp('demo') },
  script: [
    ...workspaceRules,
    {
      argv: ['ios'],
      prefix: true,
      stderr: LAUNCH_FAILED_STDERR,
      exit: 1,
      source: 'synthetic',
      note: 'Every launch fails; the code and remedy follow the old website prompt fixture, the step lines are written by hand.',
    },
    {
      argv: ['logs'],
      prefix: true,
      stdout: LAUNCH_ERROR_LOG,
      exit: 0,
      source: 'synthetic',
      note: 'Written by hand: the JavaScript error behind the failed launch.',
    },
  ],
  grade(input) {
    const all = launches(input);
    const first = all[0];
    const diagnosed = input.invocations.find(
      (each) => first !== undefined && matches(each, LOGS_ERRORS) && each.startedAt >= first.endedAt,
    );
    const early = all.slice(1).filter((each) => diagnosed === undefined || each.startedAt < diagnosed.endedAt);
    return [
      ...guided(input, IOS_LAUNCH),
      {
        name: 'ran stim logs --errors after the failed launch',
        pass: diagnosed !== undefined,
        detail: `${all.length} launches`,
      },
      {
        name: 'no stim ios rerun before reading the errors',
        pass: early.length === 0,
        detail: `${early.length} reruns`,
      },
      observe(
        'read stim guide errors STIM_LAUNCH_FAILED',
        input.invocations.some((each) => matches(each, { argv: ['guide', 'errors', 'STIM_LAUNCH_FAILED'], exit: 0 })),
      ),
    ];
  },
};

const STOP_CONTEXT = " This workspace's Stim dev server and iOS simulator are running from an earlier session.";

const stop: EvalCase = {
  id: 'website-stop',
  prompt: websitePrompt('getting-started', 'Stop the environment') + STOP_CONTEXT,
  workspace: { files: expoApp('demo') },
  script: [...workspaceRules, IOS_OK],
  grade(input) {
    const relaunched = input.invocations.filter(
      (each) => matches(each, IOS_LAUNCH) || matches(each, { argv: ['start'] }),
    );
    const removals = input.invocations.filter((each) => matches(each, { argv: ['worktree', 'remove'] }));
    return [
      ...guided(input, {
        argv: ['stop'],
        exit: 0,
        predicate: (each) => flag(each.argv, '--slot') === undefined,
      }),
      { name: 'launched nothing', pass: relaunched.length === 0, detail: `${relaunched.length} start or ios` },
      { name: 'kept the worktree', pass: removals.length === 0, detail: `${removals.length} stim worktree remove` },
    ];
  },
};

export const WEBSITE_CASES: EvalCase[] = [simulator, phone, recentErrors, separateWorktree, slots, failedLaunch, stop];
