import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentDriver,
  AgentRun,
  DriverOptions,
  EvalCase,
  Invocation,
  StimEvalConfig,
  TrialPaths,
} from './types.ts';
import { redact } from './redact.ts';

export const PACKAGE_ROOT: string = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT: string = join(PACKAGE_ROOT, '..', '..');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'stim-cli', 'skill', 'SKILL.md');
const GUIDE_CLI = join(REPO_ROOT, 'packages', 'stim-cli', 'bin', 'cli.ts');
const ENTRY = join(PACKAGE_ROOT, 'src', 'scripted-stim.ts');

export interface Arm {
  name: string;
  skill: boolean;
  blank: string[][];
}

export interface TrialOutcome {
  run: AgentRun;
  invocations: Invocation[];
  problems: string[];
  notes: string[];
  durationMs: number;
  transcript: string;
  stderr: string;
}

function git(cwd: string, home: string, args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      stdio: 'ignore',
    },
  );
}

function createPaths(): TrialPaths {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-eval-')));
  const paths: TrialPaths = {
    base,
    workspace: join(base, 'workspace'),
    bin: join(base, 'bin'),
    harness: join(base, 'harness'),
    stimHome: join(base, 'stim-home'),
    home: join(base, 'home'),
    codexHome: join(base, 'codex-home'),
  };
  for (const dir of [
    paths.bin,
    paths.harness,
    paths.stimHome,
    paths.home,
    paths.codexHome,
    join(paths.harness, 'guide-home'),
  ])
    mkdirSync(dir, { recursive: true });
  return paths;
}

function writeWorkspace(paths: TrialPaths, files: Record<string, string>): void {
  const main = join(paths.base, 'repo');
  mkdirSync(main);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(main, path)), { recursive: true });
    writeFileSync(join(main, path), text);
  }
  git(main, paths.home, ['init', '-q', '-b', 'main']);
  git(main, paths.home, ['add', '-A']);
  git(main, paths.home, ['commit', '-q', '-m', 'initial']);
  git(main, paths.home, ['worktree', 'add', '-q', '-b', 'feature/eval', paths.workspace]);
}

function writeScriptedStim(paths: TrialPaths, evalCase: EvalCase, arm: Arm): void {
  const config: StimEvalConfig = {
    rules: evalCase.script,
    blank: arm.blank,
    log: join(paths.harness, 'invocations.jsonl'),
    workspace: paths.workspace,
    guideCli: GUIDE_CLI,
    guideHome: join(paths.harness, 'guide-home'),
  };
  const configPath = join(paths.bin, 'stim-eval.json');
  writeFileSync(configPath, JSON.stringify(config));
  const wrapper = join(paths.bin, 'stim');
  writeFileSync(wrapper, `#!/bin/sh\nNODE_NO_WARNINGS=1 exec "${process.execPath}" "${ENTRY}" "${configPath}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const npx = join(paths.bin, 'npx');
  writeFileSync(
    npx,
    `#!/bin/sh\nif [ "$1" = stim ]; then\n  shift\n  exec "${wrapper}" "$@"\nfi\necho 'npx: only stim is available in this evaluation' >&2\nexit 1\n`,
  );
  chmodSync(npx, 0o755);
}

function readInvocations(paths: TrialPaths): Invocation[] {
  const log = join(paths.harness, 'invocations.jsonl');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

export interface RunOptions extends DriverOptions {
  timeoutMs: number;
  quarantineDir: string;
  signal?: AbortSignal;
}

interface AgentResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  interrupted: boolean;
  leftover: string | null;
}

const DRAIN_MS = 1000;

function stopGroup(child: ChildProcess): void {
  setImmediate(() => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      return;
    }
  });
}

function groupMembers(pgid: number): number {
  const table = spawnSync('ps', ['-axo', 'pgid=,pid='], { encoding: 'utf8' }).stdout ?? '';
  return table
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([group, pid]) => group === pgid && pid !== pgid).length;
}

function runAgent(
  paths: TrialPaths,
  command: { command: string; args: string[]; env: Record<string, string> },
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: paths.workspace,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    const finish = (code: number | null, extra: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      const pgid = child.pid;
      const members = pgid === undefined || process.platform === 'win32' ? 0 : groupMembers(pgid);
      const leftover =
        members > 0
          ? `${members} processes remain in the agent's process group after it exited and were not signalled`
          : null;
      resolve({ stdout, stderr: `${stderr}${extra}`, code, timedOut, interrupted, leftover });
    };
    const onAbort = (): void => {
      interrupted = true;
      stopGroup(child);
    };
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup(child);
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish(null, error.message));
    child.on('exit', (code) => setTimeout(() => finish(code, ''), DRAIN_MS));
    child.on('close', (code) => finish(code, ''));
  });
}

function finishDriver(driver: AgentDriver, paths: TrialPaths, killed: boolean, quarantineDir: string): string | null {
  try {
    return driver.finish(paths, { killed, quarantineDir });
  } catch (error) {
    return `the ${driver.name} cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function runTrial(
  evalCase: EvalCase,
  arm: Arm,
  driver: AgentDriver,
  options: RunOptions,
): Promise<TrialOutcome> {
  const paths = createPaths();
  const started = Date.now();
  let result: AgentResult | null = null;
  let secrets: string[] = [];
  let failure: unknown = null;
  try {
    writeWorkspace(paths, evalCase.workspace.files);
    writeScriptedStim(paths, evalCase, arm);
    driver.prepare(paths, arm.skill ? readFileSync(SKILL_PATH, 'utf8') : null);
    secrets = driver.secrets(paths);
    result = await runAgent(paths, driver.command(paths, evalCase.prompt, options), options.timeoutMs, options.signal);
  } catch (error) {
    failure = error;
  }
  try {
    const killed = result === null || result.timedOut || result.interrupted;
    const note = finishDriver(driver, paths, killed, options.quarantineDir);
    if (failure !== null || result === null) throw failure ?? new Error('the agent did not run');
    const problems: string[] = [];
    if (result.timedOut) problems.push(`the agent exceeded ${options.timeoutMs} ms and was killed`);
    if (result.interrupted) problems.push('the run was interrupted and the agent was killed');
    if (result.code !== 0 && !result.timedOut && !result.interrupted)
      problems.push(`the agent exited with ${result.code}`);
    if (result.leftover) problems.push(result.leftover);
    if (readdirSync(paths.stimHome).length > 0) problems.push('the real stim ran: the agent Stim home is not empty');
    const transcript = redact(result.stdout, secrets);
    const run = driver.parse(transcript);
    if (run.error) problems.push(run.error);
    return {
      run,
      invocations: readInvocations(paths),
      problems,
      notes: note ? [note] : [],
      durationMs: Date.now() - started,
      transcript,
      stderr: redact(result.stderr, secrets),
    };
  } finally {
    rmSync(paths.base, { recursive: true, force: true });
  }
}
