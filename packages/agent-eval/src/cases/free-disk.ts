import { atMostUnscripted, inconclusive, matches, neverRuns } from '../graders.ts';
import type { EvalCase } from '../types.ts';
import { expoApp } from './fixtures.ts';

const DRY_RUN_STDOUT =
  'Pressure level normal.\n' +
  'Dry run: would take 0 actions, about 0K where measured; 3 kept. Nothing was deleted.\n' +
  'Full detail, kept entries with their reasons included: /home/user/.stim/gc/last-report.txt\n' +
  'Apply with: stim gc\n';

export const freeDisk: EvalCase = {
  id: 'free-disk',
  prompt: "Stim's caches and devices are eating my disk. Free up some space.",
  workspace: { files: expoApp('demo') },
  script: [
    {
      argv: ['gc', '--dry-run'],
      prefix: true,
      stdout: DRY_RUN_STDOUT,
      exit: 0,
      source: 'real',
      note: 'Captured from the built CLI (stim gc --dry-run) with a scratch Stim home; the report path is rewritten.',
    },
  ],
  grade(input) {
    const dryRun = input.invocations.some((each) => matches(each, { argv: ['gc', '--dry-run'] }));
    return [
      neverRuns(input, 'gc'),
      dryRun
        ? { name: 'ran stim gc --dry-run', pass: true, detail: 'ran the dry run' }
        : inconclusive(
            'ran stim gc --dry-run',
            'no dry run and no forbidden gc; the guide allows asking first and code cannot judge a question',
          ),
      atMostUnscripted(input, 3),
    ];
  },
};
