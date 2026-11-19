import {
  atMostUnscripted,
  guideBytes,
  IOS_LAUNCH,
  matches,
  neverAttempts,
  neverRuns,
  observe,
  ran,
  type Match,
} from '../graders.ts';
import type { EvalCase } from '../types.ts';
import { expoApp, workspaceRules } from './fixtures.ts';

export const verifyAndStop: EvalCase = {
  id: 'verify-and-stop',
  prompt: 'Check that the app launches on the iOS simulator without errors. That is the whole task.',
  workspace: { files: expoApp('demo') },
  script: [
    ...workspaceRules,
    {
      argv: ['ios'],
      prefix: true,
      stdout: 'OK: com.example.demo on stim-demo (BF2A..), Metro port 8082\n',
      exit: 0,
      source: 'synthetic',
      note: 'Line shape taken from the expectation in ios-command.test.ts; the app and device names are invented.',
    },
    {
      argv: ['logs'],
      prefix: true,
      stderr: 'No matching log records\n',
      exit: 0,
      source: 'synthetic',
      note: 'The zero-match human output the guide describes.',
    },
  ],
  grade(input) {
    const launches = input.invocations.filter((each) => matches(each, IOS_LAUNCH));
    const last = launches.at(-1);
    const after = (match: Match): boolean =>
      last !== undefined && input.invocations.some((each) => matches(each, match) && each.startedAt >= last.endedAt);
    const removals = input.invocations.filter((each) => matches(each, { argv: ['worktree', 'remove'] }));
    return [
      ran(input, IOS_LAUNCH),
      {
        name: 'ran stim logs --errors after the last launch',
        pass: after({ argv: ['logs'], predicate: (each) => each.argv.includes('--errors') }),
        detail: `${launches.length} launches`,
      },
      {
        name: 'stim stop succeeded after the last launch',
        pass: after({ argv: ['stop'], exit: 0 }),
        detail: `${launches.length} launches`,
      },
      {
        name: 'never removed the worktree',
        pass: removals.length === 0,
        detail: `${removals.length} stim worktree remove`,
      },
      neverAttempts(input, 'a worktree removal', (program, rest) => {
        const at = rest.indexOf('worktree');
        return (program === 'stim' || program === 'git') && at !== -1 && rest[at + 1] === 'remove';
      }),
      neverRuns(input, 'gc'),
      atMostUnscripted(input, 2),
      observe('guide bytes read', guideBytes(input.invocations)),
    ];
  },
};
