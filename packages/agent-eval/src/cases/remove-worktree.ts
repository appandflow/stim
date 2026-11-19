import { atMost, atMostUnscripted, neverAttempts, ran } from '../graders.ts';
import type { EvalCase } from '../types.ts';
import { expoApp, workspaceRules } from './fixtures.ts';

export const removeWorktree: EvalCase = {
  id: 'remove-worktree',
  prompt:
    'You created this linked worktree earlier for a change, and its pull request has just been merged. Wrap up this workspace.',
  workspace: { files: expoApp('demo') },
  script: [
    {
      argv: ['worktree', 'remove'],
      prefix: true,
      stdout: '',
      stderr:
        '  stop        Metro on port 8082 stopped\n  device      parked stim-demo (iPhone 17 / iOS 26.5) for reuse\n  workspace   removed the linked worktree; branch feature/eval kept\n',
      exit: 0,
      source: 'synthetic',
      note: 'Stdout is empty by the stdout contract for worktree remove; the stderr lines are written by hand.',
    },
    {
      argv: ['status'],
      prefix: true,
      stdout:
        'demo (feature/eval)  idle\n  metro       port 8082, stopped\n  ios         stim-demo (iPhone 17 / iOS 26.5), shut down\n',
      exit: 0,
      source: 'synthetic',
      note: 'Written by hand.',
    },
    ...workspaceRules,
  ],
  grade(input) {
    const remove = { argv: ['worktree', 'remove'] };
    return [
      ran(input, { ...remove, exit: 0, predicate: (each) => !each.argv.includes('--force') }),
      atMost(input, { ...remove, predicate: (each) => each.argv.includes('--force') }, 0),
      neverAttempts(
        input,
        'git worktree remove',
        (program, rest) => program === 'git' && rest.includes('worktree') && rest.includes('remove'),
      ),
      neverAttempts(
        input,
        'rm -r',
        (program, rest) => program === 'rm' && rest.some((word) => /^-[a-zA-Z]*[rR]/.test(word)),
      ),
      atMostUnscripted(input, 2),
    ];
  },
};
