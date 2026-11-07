import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
export const KILL_GRACE_MS = 10_000;
const MEASURE_MS = 5000;

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void;

/** A stimd running as this process's child, which serves the home until `end` or until this process exits. */
export interface AttachedHost {
  instance: string;
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

/** Selects one engine for a CI job's hosting and API operations. */
export async function bindCIEngine(env: NodeJS.ProcessEnv): Promise<{
  host: typeof hostStimd;
  hold: typeof holdCIStimd;
  runOp: import('../api/engine-route.ts').RunOp;
  release: () => void;
}> {
  const { selectedEngineDir, loadEngineRunOp } = await import('../api/engine-route.ts');
  let selected = selectedEngineDir(env);
  const { ownStoreEngine } = await import('../daemon/engine-switch.ts');
  const own = ownStoreEngine();
  let retained = selected ?? (own ? join(own.root, own.build) : null);
  let claim: import('@stim-cli/core/ownership-claim').ClaimHandle | null = null;
  if (retained) {
    const { takeLock } = await import('../engine-store/locks.ts');
    const { buildClaimRoot } = await import('../engine-store/claims.ts');
    const { tryAcquireClaim, releaseClaim } = await import('@stim-cli/core/ownership-claim');
    const root = dirname(retained);
    let lock: Awaited<ReturnType<typeof takeLock>> = null;
    for (const until = Date.now() + 10_000; !lock && Date.now() < until;) {
      try {
        lock = await takeLock(root, '.lock.sock');
      } catch (error) {
        if (
          error instanceof Error &&
          'socketPath' in error &&
          'code' in error &&
          (error.code === 'EPERM' || error.code === 'EACCES')
        )
          throw Object.assign(new Error('The sandbox denied the Stim engine store lock.'), {
            code: SANDBOX_BLOCKED,
            remedy: 'Run outside the sandbox; `stim guide errors sandbox` explains the available allowances.',
          });
        throw error;
      }
      if (!lock) await new Promise((done) => setTimeout(done, 50));
    }
    if (!lock) throw new Error('Could not lock the Stim engine store for this CI job.');
    try {
      if (selected) selected = selectedEngineDir(env);
      retained = selected ?? (own ? join(own.root, own.build) : null);
      if (own) (await import('../daemon/engine-switch.ts')).requireCurrentEngine(own);
      if (retained && dirname(retained) === root) {
        const attempt = tryAcquireClaim({
          root: buildClaimRoot(root, basename(retained)),
          mode: 'shared',
          label: 'stim ci engine',
          details: { drained: false, engineDirs: [], retained: true },
        });
        if (attempt.pending) releaseClaim(attempt.pending);
        claim = attempt.acquired ?? null;
        if (!claim) throw new Error('Could not retain the selected Stim engine for this CI job.');
      } else if (retained) throw new Error('The selected Stim engine store changed during CI setup.');
    } finally {
      await lock.release();
    }
  }
  const { ClaimUnavailableError, releaseClaim } = await import('@stim-cli/core/ownership-claim');
  const release = () => {
    if (!claim) return;
    if (!releaseClaim(claim))
      throw new ClaimUnavailableError('could not release the CI engine claim', { claimPath: claim.path });
    claim = null;
  };
  try {
    const runOp = selected ? await loadEngineRunOp(selected) : null;
    if (selected && !runOp)
      throw Object.assign(new Error('The selected Stim engine API cannot load.'), {
        code: 'STIM_ENGINE_UNAVAILABLE',
        remedy: 'Run stim engine rollback or stim engine use to restore the engine.',
      });
    if (selected && runOp) {
      const entry = join(selected, 'dist', 'attached-stimd.mjs');
      const engine: Partial<typeof import('./attached.ts')> = existsSync(entry)
        ? await import(pathToFileURL(entry).href)
        : {};
      if (typeof engine.hostStimd !== 'function' || typeof engine.holdCIStimd !== 'function')
        throw Object.assign(new Error('The selected Stim engine cannot host a CI daemon.'), {
          code: 'STIM_ENGINE_HOST_UNAVAILABLE',
          remedy: 'Run stim engine update to select an engine that supports attached hosting.',
        });
      return { host: engine.hostStimd, hold: engine.holdCIStimd, runOp, release };
    }
    const local = (await import('../api.ts')).runOp;
    return {
      host: hostStimd,
      hold: holdCIStimd,
      runOp: (name, args, ctx) => Reflect.apply(local, undefined, [name, args, ctx]),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Holds the existing daemon for one CI job without changing its lifetime. */
export async function holdCIStimd(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
  ownedInstance: string | null,
): Promise<() => void> {
  return (await import('../api.ts')).holdCIStimd(env, projectRoot, ownedInstance);
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
): Promise<
  | AttachedHost
  | { switched: string }
  | { refusal: { code: string; message: string; remedy: string } }
  | 'held'
  | 'held-attached'
  | 'blocked'
  | 'blocked-lock'
  | 'engine-unavailable'
  | null
> {
  const args = [spawnEntry('cli'), '__stimd', ATTACHED_ARG];
  const child = getExecutor().spawn(process.execPath, handover ? args : [...args, NO_HANDOVER_ARG], {
    cwd: tmpdir(),
    stdio: ['pipe', 'pipe', 'inherit'],
    env: stimdEnv(env, process.platform),
    windowsHide: true,
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', () => done({ code: null, signal: null }));
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
      if (!isJsonObject(line)) return;
      if (
        line.op === 'attached-claim-refusal' &&
        isJsonObject(line.refusal) &&
        typeof line.refusal.code === 'string' &&
        typeof line.refusal.message === 'string' &&
        typeof line.refusal.remedy === 'string'
      ) {
        clearTimeout(timer);
        resolve({ refusal: { code: line.refusal.code, message: line.refusal.message, remedy: line.refusal.remedy } });
        return;
      }
      if (line.op === 'attached-engine-unavailable') {
        clearTimeout(timer);
        resolve('engine-unavailable');
        return;
      }
      if (line.op === 'attached-switched' && typeof line.version === 'string') {
        clearTimeout(timer);
        resolve({ switched: line.version });
        return;
      }
      if (
        line.op === 'attached-held' ||
        line.op === 'attached-held-attached' ||
        line.op === 'attached-blocked' ||
        line.op === 'attached-blocked-lock'
      ) {
        clearTimeout(timer);
        resolve(
          line.op === 'attached-held'
            ? 'held'
            : line.op === 'attached-held-attached'
              ? 'held-attached'
              : line.op === 'attached-blocked-lock'
                ? 'blocked-lock'
                : 'blocked',
        );
        return;
      }
      if (line.op !== 'attached' || typeof line.instance !== 'string') return;
      clearTimeout(timer);
      const waitMs = Number(line.waitMs) || 0;
      child.unref();
      for (const stream of [child.stdout, child.stdin]) if (stream instanceof Socket) stream.unref();
      resolve({
        instance: line.instance,
        async end() {
          child.ref();
          child.stdin?.end();
          const kill = setTimeout(() => child.kill('SIGKILL'), waitMs + KILL_GRACE_MS);
          const result = await exited;
          clearTimeout(kill);
          if (result.code !== 0)
            throw new Error(
              `Attached stimd exited ${result.signal ? `on ${result.signal}` : `with code ${String(result.code)}`}.`,
            );
        },
      });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === SANDBOX_EXIT ? 'blocked' : null);
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
  serve(requestEnd: (why: string) => void, waitMs: number, instance: string): void;
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
    serve(requestEnd, waitMs, instance) {
      process.on('SIGINT', () => {});
      process.on('SIGHUP', () => requestEnd('SIGHUP'));
      for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
      process.stdin.on('end', () => requestEnd('stdin')).on('error', () => {});
      process.stdin.resume();
      process.stdout.write(`${JSON.stringify({ op: 'attached', pid: process.pid, waitMs, instance })}\n`);
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
  admissionRevision,
  alive: measure,
  waitMs,
  handover,
  mode,
  identity,
  release,
  successorArgs,
  log,
}: {
  inFlight: () => string[];
  admissionRevision: () => number;
  alive: () => Promise<string | null>;
  waitMs: number;
  handover: boolean;
  mode: () => DaemonMode;
  identity: { build: string; version: string };
  release: (why: string) => Promise<void>;
  successorArgs: () => string[];
  log: Log;
}): Promise<void> {
  const deadline = Date.now() + waitMs;
  let shown = '';
  const drain = async () => {
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
  };
  await drain();
  let alive: string | null = null;
  const revision = admissionRevision();
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
    if (inFlight().length && Date.now() < deadline) await drain();
    if (admissionRevision() !== revision) alive ??= 'a command was admitted while measuring its home';
  }
  const unfinished = inFlight();
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
  const args = successorArgs();
  await release(
    unfinished.length
      ? `its command ended and ${unfinished.join(', ')} still ran after ${waitMs / 1000} s`
      : 'its command ended',
  );
  if (!handover || (!alive && !unfinished.length)) return;
  try {
    launchStimd(process.env, mode(), process.platform, undefined, args);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error.code !== 'EPERM' && error.code !== 'EACCES'))
      throw error;
    log('warn', 'attached_handover_blocked', 'no detached stimd took over; the next command re-adopts the home');
    return;
  }
  for (const until = Date.now() + HANDOVER_MS; Date.now() < until;) {
    if (stimdLive()) {
      log('info', 'attached_handover', 'a detached stimd took over this Stim home');
      return;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  log('warn', 'attached_handover_blocked', 'no detached stimd took over; the next command re-adopts the home');
}
