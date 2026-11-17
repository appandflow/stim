import { atMostUnscripted, observe, ran } from '../graders.ts';
import type { Check, EvalCase } from '../types.ts';
import { expoApp, prefixed } from './fixtures.ts';

const NO_PROJECT_STDERR =
  '  error       STIM_NO_PROJECT: No supported app project was found from this directory.\n' +
  '  remedy      Run this from the directory of a supported app.\n';

export const refusal: EvalCase = {
  id: 'refusal',
  prompt: 'Check the app logs for errors.',
  workspace: {
    files: {
      'package.json': `${JSON.stringify({ name: 'monorepo', private: true, workspaces: ['apps/*'] }, null, 2)}\n`,
      'README.md': '# Monorepo\n\nThe Expo app lives in apps/mobile.\n',
      ...prefixed('apps/mobile', expoApp('mobile')),
      'apps/docs/package.json': `${JSON.stringify({ name: 'docs', version: '1.0.0' }, null, 2)}\n`,
    },
  },
  script: [
    {
      argv: ['logs'],
      prefix: true,
      cwd: '.',
      stderr: NO_PROJECT_STDERR,
      exit: 1,
      source: 'real',
      note: 'Captured from the built CLI (stim logs) in an empty directory with a scratch Stim home; the development-tree notice line is dropped.',
    },
    {
      argv: ['logs'],
      prefix: true,
      cwd: 'apps/mobile',
      stdout: 'No app errors recorded for this workspace.\n',
      exit: 0,
      source: 'synthetic',
      note: 'Written by hand: the real command prints error records, and none exist here.',
    },
  ],
  grade(input) {
    const rootAttempts = input.invocations.filter((each) => each.argv[0] === 'logs' && each.cwdRelative === '.');
    const checks: Check[] = [
      ran(input, { argv: ['logs'], cwd: 'apps/mobile', exit: 0 }),
      {
        name: 'no more than two logs attempts from the refused directory',
        pass: rootAttempts.length <= 2,
        detail: `${rootAttempts.length} attempts`,
      },
      atMostUnscripted(input, 3),
      observe(
        'refusal seen',
        rootAttempts.some((each) => each.exitCode === 1),
      ),
      observe(
        'read stim guide errors',
        input.invocations.some(
          (each) => each.kind !== 'unscripted' && each.argv[0] === 'guide' && each.argv[1] === 'errors',
        ),
      ),
    ];
    return checks;
  },
};
