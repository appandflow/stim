import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentDriver,
  AgentRun,
  DriverOptions,
  EvalCase,
  Invocation,
  Roots,
  StimEvalConfig,
  TrialPaths,
} from './types.ts';
import { redact } from './redact.ts';

const PACKAGE_ROOT: string = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT: string = join(PACKAGE_ROOT, '..', '..');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'stim-cli', 'skill', 'SKILL.md');
const GUIDE_CLI = join(REPO_ROOT, 'packages', 'stim-cli', 'bin', 'cli.ts');
const RUNTIME_FILES = ['scripted-stim.ts', 'stim-script.ts'];

export function checkGuide(cli: string = GUIDE_CLI): void {
  const home = mkdtempSync(join(tmpdir(), 'stim-eval-guide-'));
  try {
    const child = spawnSync(process.execPath, [cli, 'guide', 'agent'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, STIM_HOME: home },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (child.status === 0 && child.stdout.trim() !== '') return;
    const reason = (child.stderr || child.error?.message || `exit ${child.status}`).trim().split('\n')[0];
    throw new Error(
      `stim guide agent fails in this checkout, so every trial would read a broken guide: ${reason}. Run pnpm run build first.`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export interface Arm {
  name: string;
  skill: boolean;
  blank: string[][];
}

export interface TrialOutcome {
  run: AgentRun;
  invocations: Invocation[];
  invocationsText: string;
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

function createPaths(roots: Roots): TrialPaths {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-eval-')));
  const paths: TrialPaths = {
    roots,
    base,
    workspace: join(base, 'workspace'),
    bin: join(base, 'bin'),
    harness: realpathSync(mkdtempSync(join(tmpdir(), 'stim-eval-log-'))),
    stimHome: join(base, 'stim-home'),
    home: join(base, 'home'),
    codexHome: join(base, 'codex-home'),
  };
  for (const dir of [paths.bin, paths.stimHome, paths.home, paths.codexHome, join(paths.harness, 'guide-home')])
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

function writeScriptedStim(paths: TrialPaths, evalCase: EvalCase, arm: Arm, probe: string): void {
  const config: StimEvalConfig = {
    rules: evalCase.script,
    blank: arm.blank,
    log: join(paths.harness, 'invocations.jsonl'),
    workspace: paths.workspace,
    guideCli: GUIDE_CLI,
    guideHome: join(paths.harness, 'guide-home'),
    probe,
  };
  const library = join(paths.bin, 'lib');
  mkdirSync(library);
  writeFileSync(join(library, 'package.json'), '{"type":"module"}\n');
  for (const file of RUNTIME_FILES) copyFileSync(join(PACKAGE_ROOT, 'src', file), join(library, file));
  const entry = join(library, 'scripted-stim.ts');
  const configPath = join(paths.bin, 'stim-eval.json');
  writeFileSync(configPath, JSON.stringify(config));
  const wrapper = join(paths.bin, 'stim');
  writeFileSync(wrapper, `#!/bin/sh\nNODE_NO_WARNINGS=1 exec "${process.execPath}" "${entry}" "${configPath}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const npx = join(paths.bin, 'npx');
  writeFileSync(
    npx,
    `#!/bin/sh\nif [ "$1" = stim ]; then\n  shift\n  exec "${wrapper}" "$@"\nfi\necho 'npx: only stim is available in this evaluation' >&2\nexit 1\n`,
  );
  chmodSync(npx, 0o755);
}

const KINDS = ['guide', 'scripted', 'unscripted', 'blanked'];

function isInvocation(value: unknown): value is Invocation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const text = ['cwd', 'cwdRelative', 'path', 'self'].every((key) => typeof record[key] === 'string');
  const numbers = ['startedAt', 'endedAt', 'exitCode', 'stdoutBytes', 'stderrBytes'].every(
    (key) => typeof record[key] === 'number' && Number.isFinite(record[key]),
  );
  return (
    text &&
    numbers &&
    Array.isArray(record.argv) &&
    record.argv.every((word) => typeof word === 'string') &&
    KINDS.includes(String(record.kind)) &&
    (record.homeReadable === undefined || typeof record.homeReadable === 'boolean')
  );
}

const MAX_LOG_BYTES = 4 * 1024 * 1024;

function readLog(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > MAX_LOG_BYTES) throw new Error('too large');
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readInvocations(paths: TrialPaths, final: boolean): { invocations: Invocation[]; error: string | null } {
  const log = join(paths.harness, 'invocations.jsonl');
  if (!lstatSync(log, { throwIfNoEntry: false })) return { invocations: [], error: null };
  try {
    const text = readLog(log);
    const lines = text.split('\n');
    const tail = lines.pop() ?? '';
    if (final && tail !== '') throw new Error('incomplete');
    const invocations = lines.filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isInvocation(parsed)) throw new Error('shape');
      return parsed;
    });
    return { invocations, error: null };
  } catch {
    return { invocations: [], error: 'the invocation log could not be read' };
  }
}

export interface RunOptions extends DriverOptions {
  roots: Roots;
  timeoutMs: number;
  signal?: AbortSignal;
  confine?: boolean;
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
const GRACE_MS = 2000;
const SCAN_PS_MS = [5000, 30_000];
const SCAN_LSOF_MS = [30_000, 120_000];
const SCAN_BUFFER = 32 * 1024 * 1024;

function scan(command: string, args: string[], timeouts: number[]): SpawnSyncReturns<string> | null {
  for (const timeout of timeouts) {
    const child = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: SCAN_BUFFER });
    if (!child.error && child.status !== null && child.stdout !== '') return child;
  }
  return null;
}

function unexited(child: ChildProcess): child is ChildProcess & { pid: number } {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function stopGroup(child: ChildProcess): void {
  setImmediate(() => {
    if (!unexited(child)) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      return;
    }
  });
}

function terminate(child: ChildProcess): void {
  setImmediate(() => {
    if (!unexited(child)) return;
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      return;
    }
    setTimeout(() => stopGroup(child), GRACE_MS).unref();
  });
}

function leftoverProcesses(leader: number | undefined, base: string, secrets: string[]): string | null {
  if (process.platform === 'win32') return null;
  const failed = 'could not check for leftover processes';
  const name = basename(base);
  const ps = scan('ps', ['-axo', 'pid=,pgid=,command='], SCAN_PS_MS);
  if (!ps || ps.status !== 0) return failed;
  const found = new Map<number, string>();
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[3] ?? '';
    if (pid === process.pid || pid === ps.pid || command.startsWith('ps -axo')) continue;
    if ((leader !== undefined && Number(match[2]) === leader) || command.includes(name)) found.set(pid, command);
  }
  const lsof = scan('lsof', ['-a', '-d', 'cwd', '-Fpn'], SCAN_LSOF_MS);
  if (!lsof) return failed;
  let owner = 0;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) owner = Number(line.slice(1));
    else if (line.startsWith('n') && line.slice(1).startsWith(base) && owner !== process.pid && owner !== lsof.pid)
      found.set(owner, found.get(owner) ?? `working directory ${line.slice(1)}`);
  }
  if (found.size === 0) return null;
  const list = [...found].map(([pid, command]) => `${pid} ${command.slice(0, 100)}`).join('; ');
  return redact(`processes remain after the agent exited, left for the operator and not signalled: ${list}`, secrets);
}

const NOT_STARTED: AgentResult = {
  stdout: '',
  stderr: '',
  code: null,
  timedOut: false,
  interrupted: true,
  leftover: null,
};

function runAgent(
  paths: TrialPaths,
  command: { command: string; args: string[]; env: Record<string, string> },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  secrets: string[],
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
      const leftover = leftoverProcesses(child.pid, paths.base, secrets);
      resolve({ stdout, stderr: `${stderr}${extra}`, code, timedOut, interrupted, leftover });
    };
    const onAbort = (): void => {
      interrupted = true;
      terminate(child);
    };
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish(null, error.message));
    child.on('exit', (code) => setTimeout(() => finish(code, ''), DRAIN_MS));
    child.on('close', (code) => finish(code, ''));
  });
}

function finishDriver(driver: AgentDriver, paths: TrialPaths): string | null {
  try {
    return driver.finish(paths);
  } catch (error) {
    return `the ${driver.name} cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function probeResult(invocations: Invocation[]): string | null {
  const probe = invocations.find((each) => each.homeReadable !== undefined);
  if (!probe)
    return 'the confinement probe never ran: the agent did not call stim, so the sandbox is not shown to apply';
  return probe.homeReadable
    ? 'the agent could read a marker file under the real home: the sandbox settings were not applied'
    : null;
}

export async function runTrial(
  evalCase: EvalCase,
  arm: Arm,
  driver: AgentDriver,
  options: RunOptions,
): Promise<TrialOutcome> {
  const paths = createPaths(options.roots);
  const probe = join(options.roots.home, `.stim-eval-probe-${basename(paths.base)}`);
  const started = Date.now();
  const confine = options.confine !== false;
  const stop = new AbortController();
  const onOuterAbort = (): void => stop.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  let result: AgentResult | null = null;
  let secrets: string[] = [];
  let failure: unknown = null;
  let watcher: ReturnType<typeof setInterval> | null = null;
  let logError: string | null = null;
  try {
    writeFileSync(probe, randomBytes(8).toString('hex'), { mode: 0o600 });
    writeWorkspace(paths, evalCase.workspace.files);
    writeScriptedStim(paths, evalCase, arm, probe);
    driver.prepare(paths, arm.skill ? readFileSync(SKILL_PATH, 'utf8') : null);
    secrets = driver.secrets(paths);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (options.signal?.aborted) result = NOT_STARTED;
    else {
      watcher = setInterval(() => {
        const read = readInvocations(paths, false);
        logError ??= read.error;
        if (read.error || (confine && read.invocations.some((each) => each.homeReadable === true))) stop.abort();
      }, 250);
      result = await runAgent(
        paths,
        driver.command(paths, evalCase.prompt, options),
        options.timeoutMs,
        stop.signal,
        secrets,
      );
    }
  } catch (error) {
    failure = error;
  }
  if (watcher) clearInterval(watcher);
  options.signal?.removeEventListener('abort', onOuterAbort);
  try {
    const note = finishDriver(driver, paths);
    if (failure !== null || result === null) throw failure ?? new Error('the agent did not run');
    const problems: string[] = [];
    if (result.timedOut) problems.push(`the agent exceeded ${options.timeoutMs} ms and was killed`);
    if (result.interrupted) problems.push('the run was stopped and the agent was killed');
    if (result.code !== 0 && !result.timedOut && !result.interrupted)
      problems.push(`the agent exited with ${result.code}`);
    if (result.leftover) problems.push(result.leftover);
    if (readdirSync(paths.stimHome).length > 0) problems.push('the real stim ran: the agent Stim home is not empty');
    const read = readInvocations(paths, true);
    const invocations = read.invocations;
    if (read.error ?? logError) problems.push(read.error ?? logError ?? '');
    const confinement = confine && !read.error ? probeResult(invocations) : null;
    if (confinement) problems.push(confinement);
    if (result.stdout.includes('invocations.jsonl'))
      problems.push('the transcript names the harness log file: the agent may have touched the measurement');
    const transcript = redact(result.stdout, secrets);
    const run = driver.parse(transcript);
    if (run.error) problems.push(run.error);
    return {
      run,
      invocations,
      invocationsText: redact(invocations.map((each) => JSON.stringify(each)).join('\n'), secrets),
      problems,
      notes: note ? [note] : [],
      durationMs: Date.now() - started,
      transcript,
      stderr: redact(result.stderr, secrets),
    };
  } finally {
    rmSync(probe, { force: true });
    rmSync(paths.base, { recursive: true, force: true });
    rmSync(paths.harness, { recursive: true, force: true });
  }
}
