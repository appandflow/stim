import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The Windows supervisor of `stim-server service`. It imports nothing but Node, so `install` can copy this one file
 * beside the service and it keeps working whatever server version the service runs.
 */
export interface SupervisorState {
  supervisor: number;
  server: number | null;
  runs: number;
  lastExitCode: string | null;
}

interface Program {
  argv: string[];
  environment: Record<string, string>;
  workingDirectory: string;
  logPath: string;
}

function program(file: string): Program {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const value: { [key: string]: unknown } = parsed && typeof parsed === 'object' ? { ...parsed } : {};
  const argv = Array.isArray(value.programArguments)
    ? value.programArguments.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (value.managed !== true || !argv.length || typeof value.logPath !== 'string')
    throw new Error(`${file} is not a service file install wrote.`);
  const environment: Record<string, string> = {};
  if (value.environment && typeof value.environment === 'object') {
    for (const [name, entry] of Object.entries(value.environment))
      if (typeof entry === 'string') environment[name] = entry;
  }
  const workingDirectory = typeof value.workingDirectory === 'string' ? value.workingDirectory : '';
  return { argv, environment, workingDirectory, logPath: value.logPath };
}

async function supervise(file: string, statePath: string, throttleMs: number): Promise<void> {
  let runs = 0;
  let lastExitCode: string | null = null;
  const record = (server: number | null) => {
    const state: SupervisorState = { supervisor: process.pid, server, runs, lastExitCode };
    mkdirSync(dirname(statePath), { recursive: true });
    const partial = `${statePath}.${process.pid}.tmp`;
    writeFileSync(partial, `${JSON.stringify(state)}\n`);
    renameSync(partial, statePath);
  };
  for (;;) {
    const { argv, environment, workingDirectory, logPath } = program(file);
    const [node = '', ...args] = argv;
    mkdirSync(dirname(logPath), { recursive: true });
    const out = openSync(logPath, 'a');
    const child = spawn(node, args, {
      cwd: workingDirectory || undefined,
      env: { ...process.env, ...environment },
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    closeSync(out);
    runs += 1;
    record(child.pid ?? null);
    lastExitCode = await new Promise<string>((resolve) => {
      child.once('error', (error) => resolve(error.message));
      child.once('exit', (code, signal) => resolve(code === null ? `signal ${signal}` : String(code)));
    });
    record(null);
    await sleep(throttleMs);
  }
}

const [file, statePath, throttle] = process.argv.slice(2);
if (!file || !statePath || !/^\d+$/.test(throttle ?? '')) {
  process.stderr.write('usage: stim-service-runner <service file> <state file> <restart delay seconds>\n');
  process.exitCode = 2;
} else {
  supervise(file, statePath, Number(throttle) * 1000).catch((error: unknown) => {
    process.stderr.write(`stim-service-runner: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
