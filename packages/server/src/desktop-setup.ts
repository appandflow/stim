import type { SetupCapability, SetupJournal } from '@stim-cli/core/state';
import { parseSetupArgs, runSetup, type SetupDeps } from './setup.ts';

type DesktopSetupAnswer = 'approve' | 'refuse' | 'skip';

export interface DesktopSetupRequest {
  ticket: string;
  expires: string;
  capabilities: SetupCapability[];
}

export interface DesktopSetupEvents {
  progress(journal: SetupJournal, asking: SetupCapability | null): void;
  ended(exitCode: number, output: unknown): void;
}

export interface DesktopSetup {
  /** The journal name the ticket derives, which names this request to the requesting machine and to Desktop. */
  journal: string;
  answer(answer: DesktopSetupAnswer): boolean;
  stop(): void;
  done: Promise<void>;
}

/**
 * Runs `stim-server setup` in this server for a request a person pasted into Stim Desktop on this machine. The person
 * answers each grant in Desktop where setup would ask Y/n in a terminal; everything else is setup's own: the ticket and
 * expiry checks, the exclusive setup claim, the stored secret, the journal and the wait for the requesting machine.
 * Throws when setup would refuse the request's arguments.
 */
export function startDesktopSetup(
  request: DesktopSetupRequest,
  port: number,
  version: string,
  deps: SetupDeps,
  events: DesktopSetupEvents,
): DesktopSetup {
  const args = [
    '--expires',
    request.expires,
    ...request.capabilities.map((capability) => `--${capability}`),
    '--port',
    String(port),
    '--json',
  ];
  const { journal } = parseSetupArgs(args, deps.now(), request.ticket);
  const controller = new AbortController();
  let asking: {
    capability: SetupCapability;
    finish(yes: boolean): void;
  } | null = null;
  let waking: (() => void) | null = null;
  let skipping = false;
  let latest: SetupJournal | null = null;
  let output: unknown = null;
  const report = () => {
    if (latest) events.progress(latest, asking?.capability ?? null);
  };
  const done = runSetup(args, version, {
    ...deps,
    ticket: request.ticket,
    tty: true,
    display: undefined,
    signal: controller.signal,
    stdout: (line) => {
      try {
        output = JSON.parse(line);
      } catch {
        output = null;
      }
    },
    stderr: () => {},
    write: (hash, value) => {
      deps.write(hash, value);
      latest = structuredClone(value);
      report();
    },
    confirm: (_question, timeoutMs, capability) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => finish(false), timeoutMs);
        const finish = (yes: boolean) => {
          clearTimeout(timer);
          if (asking?.finish === finish) asking = null;
          resolve(yes);
          report();
        };
        asking = { capability, finish };
        report();
      }),
    permissionWait: (ms) =>
      new Promise<boolean>((resolve) => {
        if (skipping) {
          skipping = false;
          return resolve(true);
        }
        const timer = setTimeout(() => finish(false), ms);
        const finish = (skip: boolean) => {
          clearTimeout(timer);
          waking = null;
          resolve(skip);
        };
        waking = () => finish(true);
      }),
  }).then(
    (exitCode) => events.ended(exitCode, output),
    (error: unknown) =>
      events.ended(1, { ok: false, warnings: [error instanceof Error ? error.message : String(error)] }),
  );
  return {
    journal,
    answer(answer) {
      if (answer === 'skip') {
        if (waking) waking();
        else if (latest?.steps.some((step) => step.state === 'running' && step.id.startsWith('permissions.')))
          skipping = true;
        else return false;
        return true;
      }
      if (!asking) return false;
      asking.finish(answer === 'approve');
      return true;
    },
    stop() {
      controller.abort();
      asking?.finish(false);
      waking?.();
    },
    done,
  };
}
