import type { Check } from './types.ts';

export interface TrialRecord {
  index: number;
  pass: boolean;
  inconclusive: boolean;
  invalid: string[];
  checks: Check[];
  guideBytes: number;
  turns: number | null;
  tokens: number;
  costUsd: number | null;
  durationMs: number;
}

export interface CellResult {
  agent: string;
  case: string;
  arm: string;
  planned: number;
  trials: TrialRecord[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function casePassed(cell: CellResult): boolean {
  return cell.trials.length === cell.planned && cell.trials.every((trial) => trial.pass && trial.invalid.length === 0);
}

function format(value: number | null): string {
  return value === null ? '-' : String(Math.round(value));
}

export function markdownTable(cells: CellResult[]): string {
  const rows = [
    '| agent | case | arm | trials passed | inconclusive | median guide bytes | median turns | median tokens |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const cell of cells) {
    const valid = cell.trials.filter((trial) => trial.invalid.length === 0);
    const passed = valid.filter((trial) => trial.pass).length;
    const unclear = valid.filter((trial) => trial.inconclusive).length;
    const invalid = cell.trials.length - valid.length;
    const status = `${passed}/${cell.planned}${invalid > 0 ? ` (${invalid} invalid)` : ''}${cell.trials.length < cell.planned ? ' (not run)' : ''}`;
    const turns = median(cell.trials.flatMap((trial) => (trial.turns === null ? [] : [trial.turns])));
    rows.push(
      `| ${cell.agent} | ${cell.case} | ${cell.arm} | ${status} | ${unclear} | ${format(median(cell.trials.map((trial) => trial.guideBytes)))} | ${format(turns)} | ${format(median(cell.trials.map((trial) => trial.tokens)))} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}
