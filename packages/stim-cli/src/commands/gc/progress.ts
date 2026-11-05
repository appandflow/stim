import chalk from 'chalk';
import { phaseLine } from '../../command-output.ts';
import type { StimContext } from '@stim-cli/core';

export function phase(label: string, text: string, context?: StimContext): void {
  const line = chalk.dim(phaseLine(label, text));
  if (context) context.output('stderr', `${line}\n`);
  else console.error(line);
}
