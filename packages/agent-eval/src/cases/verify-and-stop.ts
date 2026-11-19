import { atMostUnscripted, guideBytes, neverRuns, observe, ran, ranAfter } from '../graders.ts';
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
    const errors = { argv: ['logs'], predicate: (each: { argv: string[] }) => each.argv.includes('--errors') };
    return [
      ran(input, { argv: ['ios'] }),
      ranAfter(input, { argv: ['ios'] }, errors),
      ranAfter(input, { argv: ['ios'] }, { argv: ['stop'], exit: 0 }),
      neverRuns(input, 'gc'),
      atMostUnscripted(input, 2),
      observe(
        'ran stim worktree remove',
        input.invocations.some((each) => each.argv[0] === 'worktree' && each.argv[1] === 'remove'),
      ),
      observe('guide bytes read', guideBytes(input.invocations)),
    ];
  },
};
