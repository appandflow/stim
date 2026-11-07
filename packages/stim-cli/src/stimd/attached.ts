import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isJsonObject,
  loadConfig,
  machineSettingValue,
  readJsonObject,
  stimdRunDir,
  type DaemonMode,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { launchStimd, SANDBOX_BLOCKED, stimdEnv, stimdLive } from '../daemon/client.ts';
import { daemonMode } from '../daemon/mode.ts';

/** The `__stimd` argument of a stimd bound to the process that started it, which ends it by closing its stdin. */
export const ATTACHED_ARG = '--attached';
/** The `__stimd` argument of an attached stimd that never hands its home over to a detached stimd, for `stim ci`. */
export const NO_HANDOVER_ARG = '--no-handover';
/** The exit code of an attached stimd that cannot bind its socket because a sandbox denies it. */
export const SANDBOX_EXIT = 77;

const JOURNAL_FORMAT = 1;
const DEFAULT_WAIT_SECONDS = 120;
const BIND_MS = 10_000;
const POLL_MS = 200;
const HANDOVER_MS = 2000;
const KILL_GRACE_MS = 10_000;
const MEASURE_MS = 5000;

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void;

/** A stimd running as this process's child, which serves the home until `end` or until this process exits. */
export interface AttachedHost {
  /** Asks the attached stimd to end and resolves once it exited, at most its exit wait plus 10 s later. */
  end(): Promise<void>;
}

/** `daemon.attachedExitWaitSeconds` in milliseconds; an invalid or unreadable value counts as its default. */
export function attachedExitWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const { value, error } = machineSettingValue('daemon.attachedExitWaitSeconds', { config: loadConfig(), env });
    return (error ? DEFAULT_WAIT_SECONDS : Number(value)) * 1000;
  } catch {
    return DEFAULT_WAIT_SECONDS * 1000;
  }
}

/**
 * Starts this build's stimd as a child of this process (`__stimd --attached`), with stimd's environment taken from
 * `env`, and waits until it serves. It runs until this process calls `end` or exits, which closes its stdin. Resolves
 * `held` when another stimd took the home first, `blocked` when a sandbox denies its socket, and null when it failed
 * otherwise or did not serve within 10 s.
 */
export function hostStimd(
  env: NodeJS.ProcessEnv,
  { handover = true }: { handover?: boolean } = {},
): Promise<AttachedHost | 'held' | 'blocked' | null> {
  const args = [spawnEntry('cli'), '__stimd', '--mode', daemonMode(env), ATTACHED_ARG];
  const child = getExecutor().spawn(process.execPath, handover ? args : [...args, NO_HANDOVER_ARG], {
    cwd: tmpdir(),
    stdio: ['pipe', 'pipe', 'inherit'],
    env: stimdEnv(env, process.platform),
    windowsHide: true,
  });
  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => done(code));
    child.once('error', () => done(null));
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, BIND_MS);
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let line: unknown;
      try {
        line = JSON.parse(buffer.slice(0, end));
      } catch {}
      buffer = '';
      if (!isJsonObject(line) || line.op !== 'attached') return;
      clearTimeout(timer);
      const waitMs = Number(line.waitMs) || 0;
      child.unref();
      for (const stream of [child.stdout, child.stdin]) if (stream instanceof Socket) stream.unref();
      resolve({
        async end() {
          child.ref();
          child.stdin?.end();
          const kill = setTimeout(() => child.kill('SIGKILL'), waitMs + KILL_GRACE_MS);
          await exited;
          clearTimeout(kill);
        },
      });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === SANDBOX_EXIT ? 'blocked' : code === 0 ? 'held' : null);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** How a stimd's lifetime changes what it does: detached by default, attached under `hostStimd`. */
export interface StimdLifetime {
  /** Claim attempts after the first: none attached, where a held home is answered at once. */
  retries(detached: number): number;
  /** Empty ticks before an idle exit: never attached, where its command ends it. */
  idleTicks(detached: number): number;
  /** The level of a failed listen: an attached stimd's denied socket is no abnormal boot. */
  failLevel: 'warn' | 'error';
  /** Whether it keeps serving under `daemon.mode` off, with no passes. */
  keepsServingWhenOff: boolean;
  /** `make()` for a detached stimd; null attached, which neither follows the engine nor rolls it back. */
  detachedOnly<T>(make: () => T): T | null;
  /**
   * Its version, and for an attached stimd `attached: true`, in its `engine-changed` refusal of another build's client,
   * which then does not wait for a successor of its own build, since an attached stimd never relaunches.
   */
  refusal: { version: string; attached?: true };
  /** The error a failed listen ends the boot with: an attached stimd's denied socket is {@link SANDBOX_BLOCKED}. */
  listenFailed(error: unknown): unknown;
  /**
   * An attached stimd's answer to a signal: the terminal's SIGINT reaches the whole process group, so it waits for its
   * command to end instead; any other signal ends it as its command's end does.
   */
  signal(signal: NodeJS.Signals, requestEnd: (why: string) => void): void;
  /** Once bound: an attached stimd tells `hostStimd` it serves and ends at the end of its stdin. */
  serve(requestEnd: (why: string) => void, waitMs: number): void;
}

export function stimdLifetime(attached: boolean, version: string): StimdLifetime {
  if (!attached)
    return {
      retries: (detached) => detached,
      idleTicks: (detached) => detached,
      failLevel: 'error',
      keepsServingWhenOff: false,
      detachedOnly: (make) => make(),
      refusal: { version },
      listenFailed: (error) => error,
      signal: () => {},
      serve: () => {},
    };
  return {
    retries: () => 0,
    idleTicks: () => Infinity,
    failLevel: 'warn',
    keepsServingWhenOff: true,
    detachedOnly: () => null,
    refusal: { version, attached: true },
    listenFailed: (error) =>
      error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')
        ? Object.assign(new Error(error.message), { code: SANDBOX_BLOCKED })
        : error,
    signal: (signal, requestEnd) => {
      if (signal !== 'SIGINT') requestEnd(signal);
    },
    serve(requestEnd, waitMs) {
      process.on('SIGINT', () => {});
      process.on('SIGHUP', () => requestEnd('SIGHUP'));
      for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
      process.stdin.on('end', () => requestEnd('stdin')).on('error', () => {});
      process.stdin.resume();
      process.stdout.write(`${JSON.stringify({ op: 'attached', pid: process.pid, waitMs })}\n`);
    },
  };
}

const journalFile = (): string => join(stimdRunDir(), 'stimd-journal.json');

/**
 * Logs and removes the journal the last attached stimd of this home wrote as it exited, so the next stimd's log
 * carries what was still running; a journal of another format is discarded.
 */
export function readoptJournal(log: Log): void {
  const journal = readJsonObject(journalFile());
  if (!journal) return;
  rmSync(journalFile(), { force: true });
  if (journal.format !== JOURNAL_FORMAT) {
    log('warn', 'stimd_journal_discarded', `discarded an attached stimd's journal of format ${String(journal.format)}`);
    return;
  }
  const unfinished = Array.isArray(journal.unfinished) ? journal.unfinished.map(String) : [];
  log(
    'info',
    'stimd_readopted',
    `took over from the attached stimd pid ${String(journal.pid)} (${String(journal.version)}), which exited at ${String(journal.at)}${journal.alive ? ` while ${String(journal.alive)}` : ''}${unfinished.length ? `; ${unfinished.join(', ')} still ran` : ''}`,
  );
}

/**
 * How an attached stimd ends once its command ended: it waits up to `waitMs` for the other commands' operations
 * (`inFlight`, their command names) to end, naming them on stderr, writes the journal, releases the home, and then,
 * when `handover` is on and work remains in the home (`alive`, measured then), starts a detached stimd and waits 2 s for
 * it to take the home. A command admitted during the wait that still runs at its end loses its op and runs on unpinned;
 * the next command starts or hosts the next stimd.
 */
export async function endAttached({
  inFlight,
  alive: measure,
  waitMs,
  handover,
  mode,
  identity,
  release,
  log,
}: {
  inFlight: () => string[];
  alive: () => Promise<string | null>;
  waitMs: number;
  handover: boolean;
  mode: DaemonMode;
  identity: { build: string; version: string };
  release: (why: string) => void;
  log: Log;
}): Promise<void> {
  const deadline = Date.now() + waitMs;
  let shown = '';
  for (;;) {
    await new Promise((done) => setTimeout(done, POLL_MS));
    const others = [...new Set(inFlight())];
    if (!others.length || Date.now() >= deadline) break;
    if (others.join(', ') === shown) continue;
    shown = others.join(', ');
    const message = `waiting up to ${Math.ceil((deadline - Date.now()) / 1000)} s for ${shown} to finish`;
    process.stderr.write(`stimd: ${message}\n`);
    log('info', 'attached_waiting', message);
  }
  const unfinished = inFlight();
  let alive: string | null = null;
  if (handover) {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>((done) => {
      timer = setTimeout(() => done('its home was not measured in time'), MEASURE_MS);
    });
    alive = await Promise.race([
      measure().catch((error: unknown) => `its home could not be measured: ${String(error)}`),
      late,
    ]);
    clearTimeout(timer);
  }
  if (alive || unfinished.length) {
    try {
      const at = new Date().toISOString();
      const journal = { format: JOURNAL_FORMAT, pid: process.pid, ...identity, at, alive, unfinished };
      const tmp = `${journalFile()}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      renameSync(tmp, journalFile());
    } catch (error) {
      log('warn', 'stimd_journal_failed', error instanceof Error ? error.message : String(error));
    }
  }
  release(
    unfinished.length
      ? `its command ended and ${unfinished.join(', ')} still ran after ${waitMs / 1000} s`
      : 'its command ended',
  );
  if (!handover || (!alive && !unfinished.length)) return;
  launchStimd(process.env, mode);
  for (const until = Date.now() + HANDOVER_MS; Date.now() < until;) {
    if (stimdLive()) {
      log('info', 'attached_handover', 'a detached stimd took over this Stim home');
      return;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  log('warn', 'attached_handover_blocked', 'no detached stimd took over; the next command re-adopts the home');
}
