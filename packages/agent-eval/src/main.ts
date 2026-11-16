import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CASES } from './cases/index.ts';
import { claudeDriver } from './drivers/claude.ts';
import { codexDriver } from './drivers/codex.ts';
import { casePassed, markdownTable } from './report.ts';
import { runEvals } from './run.ts';
import { trapSignals } from './interrupt.ts';
import { resultsRoot } from './roots.ts';
import { REPO_ROOT, type Arm } from './trial.ts';
import type { AgentDriver, Roots } from './types.ts';

const USAGE = `usage: pnpm --filter @stim-cli/agent-eval run eval [options]

  --agent claude|codex|both   agent CLI to drive (default claude)
  --case <id>[,<id>]          cases to run (default: all of ${CASES.map((each) => each.id).join(', ')})
  --trials <n>                trials per case and arm (default 3)
  --without skill|guide:<words>
                              add a second arm: no skill, or the output of that guide command blanked
  --model <name>              model passed to the agent (default haiku for claude, the CLI default for codex)
  --max-runs <n>              ceiling on agent runs for this invocation (default 12)
  --timeout <seconds>         per-run timeout (default 300)
  --bin <path>                agent binary, for the chosen agent
`;

function positive(name: string, text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} needs a positive whole number`);
  return value;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export async function main(argv: string[], roots: Roots): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'string', default: 'claude' },
      case: { type: 'string' },
      trials: { type: 'string', default: '3' },
      without: { type: 'string' },
      model: { type: 'string' },
      'max-runs': { type: 'string', default: '12' },
      timeout: { type: 'string', default: '300' },
      bin: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (values.bin !== undefined && values.agent === 'both')
    throw new Error('--bin names one agent binary; choose --agent claude or codex');
  const drivers: AgentDriver[] =
    values.agent === 'both' ? [claudeDriver, codexDriver] : values.agent === 'codex' ? [codexDriver] : [claudeDriver];
  if (!['claude', 'codex', 'both'].includes(values.agent)) throw new Error('--agent is claude, codex or both');
  const wanted = values.case ? values.case.split(',') : CASES.map((each) => each.id);
  const unknown = wanted.filter((id) => !CASES.some((each) => each.id === id));
  if (unknown.length > 0)
    throw new Error(`unknown case ${unknown.join(', ')}; choose from ${CASES.map((each) => each.id).join(', ')}`);

  const arms: Arm[] = [{ name: 'with skill', skill: true, blank: [] }];
  if (values.without === 'skill') arms.push({ name: 'without skill', skill: false, blank: [] });
  else if (values.without?.startsWith('guide:'))
    arms.push({
      name: `without ${values.without}`,
      skill: true,
      blank: [values.without.slice('guide:'.length).split(/\s+/)],
    });
  else if (values.without !== undefined) throw new Error('--without is skill or guide:<words>');

  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const startedAt = new Date().toISOString();
  const directory = join(resultsRoot(roots), `${startedAt.replaceAll(':', '-')}-${sha}`);
  privateDirectory(directory);

  const interrupt = trapSignals(process, (code) => process.exit(code));
  const outcome = await runEvals({
    roots,
    signal: interrupt.signal,
    cases: CASES.filter((each) => wanted.includes(each.id)),
    drivers,
    arms,
    trials: positive('trials', values.trials),
    maxRuns: positive('max-runs', values['max-runs']),
    timeoutMs: positive('timeout', values.timeout) * 1000,
    model: values.model ?? null,
    bin: values.bin ?? null,
    onProgress: (line) => process.stderr.write(`${line}\n`),
    onTrial(cell, artifacts) {
      const folder = join(
        directory,
        cell.agent,
        cell.case,
        `${cell.arm.replaceAll(/[^a-z0-9]+/gi, '-')}-${cell.index}`,
      );
      privateDirectory(folder);
      writeFileSync(join(folder, 'transcript.jsonl'), artifacts.transcript, { mode: 0o600 });
      writeFileSync(join(folder, 'stderr.txt'), artifacts.stderr, { mode: 0o600 });
      writeFileSync(join(folder, 'invocations.jsonl'), artifacts.invocations, { mode: 0o600 });
    },
  });

  writeFileSync(
    join(directory, 'results.json'),
    `${JSON.stringify({ startedAt, commit: sha, agents: drivers.map((each) => each.name), model: values.model ?? null, runsUsed: outcome.runsUsed, maxRuns: positive('max-runs', values['max-runs']), cells: outcome.cells.map((cell) => ({ ...cell, passed: casePassed(cell) })) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(markdownTable(outcome.cells));
  process.stderr.write(`results: ${directory}\n`);
  interrupt.release();
  return interrupt.received() ?? 0;
}
