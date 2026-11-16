import { atMostUnscripted, exitedBefore, guideBytes, observe, ran } from '../graders.ts';
import type { EvalCase } from '../types.ts';
import { expoApp } from './fixtures.ts';

export const firstLaunch: EvalCase = {
  id: 'first-launch',
  prompt: 'Run the app on the iOS simulator.',
  workspace: { files: expoApp('demo') },
  script: [
    {
      argv: ['worktree', 'warm'],
      stdout: '',
      exit: 0,
      source: 'synthetic',
      note: 'Stdout is empty by the stdout contract for worktree warm (AGENTS.md invariant 7); progress on stderr and the exit code are assumed.',
    },
    {
      argv: ['start'],
      prefix: true,
      stdout: 'Metro for this workspace listens on port 8082.\n',
      exit: 0,
      source: 'synthetic',
      note: 'Written by hand; the real line carries more fields.',
    },
    {
      argv: ['ios'],
      prefix: true,
      stdout: 'OK: com.example.demo on stim-demo (BF2A..), Metro port 8082\n',
      exit: 0,
      source: 'synthetic',
      note: 'Line shape taken from the expectation in ios-command.test.ts; the app and device names are invented.',
    },
    {
      argv: ['doctor'],
      prefix: true,
      stdout:
        'Doctor (all platforms)\n  pressure    normal\n\nToolchain\n  node        ok\n  xcodebuild  ok\n\n0 finding(s).\n',
      exit: 0,
      source: 'synthetic',
      note: 'The real doctor output lists machine paths and host memory pressure; this is a short clean report written by hand.',
    },
    {
      argv: ['logs'],
      prefix: true,
      stdout: '',
      exit: 0,
      source: 'synthetic',
      note: 'No error records: empty output.',
    },
    {
      argv: ['stop'],
      prefix: true,
      stdout: 'Stopped: Metro on port 8082 stopped, stim-demo shut down.\n',
      exit: 0,
      source: 'synthetic',
      note: 'Written by hand.',
    },
  ],
  grade(input) {
    return [
      ran(input, { argv: ['guide'], exit: 0 }),
      ran(input, { argv: ['worktree', 'warm'], exit: 0 }),
      ran(input, { argv: ['ios'] }),
      exitedBefore(input, { argv: ['worktree', 'warm'] }, { argv: ['start'] }),
      exitedBefore(input, { argv: ['worktree', 'warm'] }, { argv: ['ios'] }),
      atMostUnscripted(input, 2),
      observe('guide bytes read', guideBytes(input.invocations)),
    ];
  },
};
