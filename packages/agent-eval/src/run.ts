import { guideBytes, verdict } from './graders.ts';
import type { CellResult, TrialRecord } from './report.ts';
import { runTrial, type Arm } from './trial.ts';
import type { AgentDriver, EvalCase } from './types.ts';

export interface EvalOptions {
  cases: EvalCase[];
  drivers: AgentDriver[];
  arms: Arm[];
  trials: number;
  maxRuns: number;
  timeoutMs: number;
  model: string | null;
  bin: string | null;
  signal?: AbortSignal;
  confine?: boolean;
  onProgress(line: string): void;
  onTrial(
    cell: { agent: string; case: string; arm: string; index: number },
    artifacts: { transcript: string; stderr: string; invocations: string },
  ): void;
}

export interface EvalOutcome {
  cells: CellResult[];
  runsUsed: number;
}

export async function runEvals(options: EvalOptions): Promise<EvalOutcome> {
  const cells: CellResult[] = [];
  let runsUsed = 0;
  for (const driver of options.drivers) {
    for (const evalCase of options.cases) {
      for (const arm of options.arms) {
        const cell: CellResult = {
          agent: driver.name,
          case: evalCase.id,
          arm: arm.name,
          planned: options.trials,
          trials: [],
        };
        cells.push(cell);
        for (let index = 1; index <= options.trials; index += 1) {
          if (options.signal?.aborted) continue;
          if (runsUsed >= options.maxRuns) {
            options.onProgress(
              `run ceiling ${options.maxRuns} reached; ${driver.name} ${evalCase.id} ${arm.name} trial ${index} not run`,
            );
            continue;
          }
          runsUsed += 1;
          options.onProgress(
            `run ${runsUsed}/${options.maxRuns}: ${driver.name} ${evalCase.id} ${arm.name} trial ${index}`,
          );
          let outcome;
          try {
            outcome = await runTrial(evalCase, arm, driver, options);
          } catch (error) {
            cell.trials.push({
              index,
              pass: false,
              inconclusive: false,
              invalid: [
                `the trial failed before it could be graded: ${error instanceof Error ? error.message : String(error)}`,
              ],
              checks: [],
              guideBytes: 0,
              turns: null,
              tokens: 0,
              costUsd: null,
              durationMs: 0,
            });
            continue;
          }
          for (const note of outcome.notes) options.onProgress(note);
          const invalid = [...outcome.problems];
          const isolation = outcome.run.isolation;
          if (isolation) {
            const expected = driver.expectedSkills(arm.skill);
            const extra = isolation.skills.filter((skill) => !expected.includes(skill));
            if (extra.length > 0) invalid.push(`unexpected skills in the agent: ${extra.join(', ')}`);
            if (isolation.mcpServers.length > 0)
              invalid.push(`MCP servers in the agent: ${isolation.mcpServers.join(', ')}`);
            if (isolation.plugins.length > 0) invalid.push(`plugins in the agent: ${isolation.plugins.join(', ')}`);
          }
          const checks = evalCase.grade({ invocations: outcome.invocations, run: outcome.run });
          const tokens = outcome.run.tokens.input + outcome.run.tokens.output;
          const record: TrialRecord = {
            index,
            pass: verdict(checks) === 'pass',
            inconclusive: verdict(checks) === 'inconclusive',
            invalid,
            checks,
            guideBytes: guideBytes(outcome.invocations),
            turns: outcome.run.turns,
            tokens,
            costUsd: outcome.run.costUsd,
            durationMs: outcome.durationMs,
          };
          cell.trials.push(record);
          options.onTrial(
            { agent: driver.name, case: evalCase.id, arm: arm.name, index },
            {
              transcript: outcome.transcript,
              stderr: outcome.stderr,
              invocations: outcome.invocationsText,
            },
          );
        }
      }
    }
  }
  return { cells, runsUsed };
}
