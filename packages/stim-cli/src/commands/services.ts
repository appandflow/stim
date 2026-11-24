import chalk from 'chalk';
import { defineOp, type Op } from '../cli/define-op.ts';
import { runProcessOperation } from '../cli-operation.ts';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { ensurePersistentStimd } from '../daemon/client.ts';
import {
  declaredServices,
  serviceLogFile,
  serviceRecords,
  serviceRunning,
  servicesEnv,
  ServiceError,
  startServices,
  stopServices,
  type ServiceOutcome,
} from '../services.ts';
import { findCommandWorkspace } from '../workspace/project.ts';
import { recordWorkspaceUseAsync } from '../workspace/workspace-state.ts';

function refuse(error: unknown, json: boolean): void {
  const failure =
    error instanceof ServiceError
      ? { code: error.code, message: error.message, remedy: error.remedy }
      : {
          code: 'STIM_SERVICE_FAILED',
          message: error instanceof Error ? error.message : String(error),
          remedy: 'Run stim services to see each service, and stim logs for its command output.',
        };
  if (json) console.log(JSON.stringify(failure));
  console.error(chalk.red(phaseLine('error', `${failure.code}: ${failure.message}`)));
  if (failure.remedy) console.error(phaseLine('remedy', failure.remedy));
  process.exitCode = 1;
}

async function inWorkspace(json: boolean, action: (root: string) => Promise<void>): Promise<void> {
  const root = findCommandWorkspace(process.cwd());
  if (!root) {
    refuseNoProject({ json });
    return;
  }
  try {
    await action(root);
  } catch (error) {
    refuse(error, json);
  }
}

/** Prints the outcomes and fails the command on a failed one, naming the service and its command. */
function report(outcomes: ServiceOutcome[], json: boolean): void {
  for (const { name, outcome, detail } of outcomes) console.error(`${name}  ${outcome}  ${detail}`);
  const failed = outcomes.find((outcome) => outcome.outcome === 'failed');
  if (json) console.log(JSON.stringify({ services: outcomes }));
  if (failed) {
    if (!json) console.error(chalk.red(phaseLine('error', `STIM_SERVICE_FAILED: ${failed.name}: ${failed.detail}`)));
    process.exitCode = 1;
  }
}

const json = { flags: '--json', description: 'print one JSON payload' } as const;

const startCommand = defineOp({
  name: 'start',
  arguments: '[name]',
  description: 'Start the declared services, or the one named, dependencies first; a running one is left alone',
  options: { json },
  run: ({ args: [name], options: opts }) =>
    inWorkspace(Boolean(opts.json), async (root) => {
      await recordWorkspaceUseAsync(root);
      const { value } = await runProcessOperation(root, (context) =>
        startServices(root, name, { operation: context, signal: context.signal }),
      );
      // @ref LLP 0027#the-idle-pass-stops-services -- stimd must run to stop them once the workspace idles
      await ensurePersistentStimd();
      report(value, Boolean(opts.json));
    }),
});

const stopCommand = defineOp({
  name: 'stop',
  arguments: '[name]',
  description: 'Stop the services Stim started, or the one named; their data and ports stay',
  options: { json },
  run: ({ args: [name], options: opts }) =>
    inWorkspace(Boolean(opts.json), async (root) => {
      await recordWorkspaceUseAsync(root);
      const { value } = await runProcessOperation(root, (context) =>
        stopServices(root, name, 'command', { operation: context, signal: context.signal }),
      );
      report(value, Boolean(opts.json));
    }),
});

const envCommand = defineOp({
  name: 'env',
  arguments: '[name]',
  description: "Print the declared services' environment as shell exports",
  options: { json },
  run: ({ args: [name], options: opts }) =>
    inWorkspace(Boolean(opts.json), async (root) => {
      const env = await servicesEnv(root, name);
      if (opts.json) {
        console.log(JSON.stringify({ services: env }));
        return;
      }
      for (const vars of Object.values(env))
        for (const [key, value] of Object.entries(vars))
          console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`);
    }),
});

const servicesOp: Op = defineOp({
  name: 'services',
  description: 'List the workspace services the project declares and whether each runs',
  positionalOptions: true,
  options: { json },
  commands: [startCommand, stopCommand, envCommand],
  run: ({ options: opts }) =>
    inWorkspace(Boolean(opts.json), async (root) => {
      const records = serviceRecords(root);
      const rows = [];
      for (const definition of declaredServices(root)) {
        const record = records[definition.name];
        rows.push({
          name: definition.name,
          kind: definition.stop ? 'commands' : 'process',
          running: record ? await serviceRunning(record) : false,
          ports: record?.ports ?? Object.fromEntries(Object.keys(definition.ports).map((label) => [label, null])),
          stoppedBy: record?.state === 'stopped' ? (record.stoppedBy ?? null) : null,
          ...(record?.process ? { pid: record.process.pid, log: serviceLogFile(root, definition.name) } : {}),
        });
      }
      if (opts.json) {
        console.log(JSON.stringify({ services: rows }));
        return;
      }
      if (!rows.length) {
        console.log('No services declared. Declare them in the services setting (stim guide services).');
        return;
      }
      for (const row of rows) {
        const ports = Object.entries(row.ports)
          .map(([label, port]) => `${label} ${port ?? '-'}`)
          .join(', ');
        const state = row.running ? 'running' : row.stoppedBy === 'idle' ? 'stopped idle' : 'stopped';
        console.log(`${row.name}  ${state}${ports ? `  ${ports}` : ''}`);
      }
    }),
});

export default servicesOp;
