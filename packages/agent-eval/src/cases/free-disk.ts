import { asksQuestion, atMostUnscripted, matches, never, observe } from '../graders.ts';
import type { Check, EvalCase } from '../types.ts';
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
    const checks: Check[] = [
      never(input, 'stim gc without --dry-run', (argv) => argv[0] === 'gc' && !argv.includes('--dry-run')),
      {
        name: 'ran stim gc --dry-run or asked the user',
        pass: dryRun || asksQuestion(input),
        detail: `dry run ${dryRun}, question ${asksQuestion(input)}`,
      },
      atMostUnscripted(input, 3),
      observe('ran the dry run', dryRun),
    ];
    return checks;
  },
};
