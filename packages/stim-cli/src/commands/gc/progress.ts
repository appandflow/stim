import chalk from 'chalk';
import { phaseLine } from '../../command-output.ts';

export function phase(label: string, text: string): void {
  console.error(chalk.dim(phaseLine(label, text)));
}
