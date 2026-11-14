import type { ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import { ownStoreEngine } from '../../daemon/engine-switch.ts';
import { getExecutor } from '../../exec.ts';
import { createNdjsonWriter } from '../../ndjson.ts';
import {
  claimRemoveCommand,
  markClaimChildPending,
  processGroupAlive,
  readClaimSet,
  releaseClaim,
  setClaimChild,
  updateClaimDetails,
  type ClaimHandle,
  type ClaimHolder,
} from '../../ownership-claim.ts';
import { captureProcessToken, inspectProcessIdentity } from '../../process-identity.ts';
import { spawnEntry } from '../../spawn-entry.ts';
import { getConfigDir } from '../../workspace/config.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import type { MetroRunMessage } from '../metro/child-server.ts';
import { retakeClaim, stopHelperProcess, stopProcessGroup } from '../metro/group-stop.ts';
import { claimPath, consoleExitFile, pendingChildRemoveCommand } from './claim.ts';
import { CONSOLE_RUN_ACCEPT, CONSOLE_STOP_MS, deviceConsoleArgs } from './ios-device.ts';
import { unregisterStreamAll } from './state.ts';

const HANDSHAKE_MS = 20_000;
const POLL_MS = 50;
const LABEL = 'device log stream';
const GROUP = 'device console';

type Identity = { pid: number; processToken: string };

/** A physical iPhone console that runs under its own helper process, so it outlives the stimd that started it. */
export interface ConsoleStream {
  id: string;
  root: string;
  claim: ClaimHandle;
  helper: Identity;
  leader: Identity;
  runId: string | null;
  attribution: Record<string, unknown>;
  revision: number;
  settling: Promise<void> | null;
  /** Why the last settle refused; the watcher leaves the entry alone until a stop or start tries again. */
  refused: { error: Error; since: string } | null;
}

const identityOf = (value: unknown): Identity | null =>
  isJsonObject(value) && typeof value.pid === 'number' && typeof value.processToken === 'string'
    ? { pid: value.pid, processToken: value.processToken }
    : null;

const helperLog = (root: string, streamId: string) => consoleExitFile(root, streamId).replace(/\.exit\.json$/, '.log');

/**
 * The refusal when what is left of a console cannot be verified stopped: the claim stays, with how to clear it. The
 * remedy names a kill only for what can still be this console's: devicectl's group while its leader does not read
 * `different` and the group lives, the helper while it reads `same` or `unknown`.
 */
function unverified(entry: ConsoleStream, detail: string): Error {
  const { leader, helper } = entry;
  const group = inspectProcessIdentity(leader) !== 'different' && processGroupAlive(leader.pid);
  const helperRuns = ['same', 'unknown'].includes(inspectProcessIdentity(helper));
  const steps = [
    group
      ? `check that \`pgrep -lg ${leader.pid}\` lists devicectl, then stop its group with \`kill -TERM -${leader.pid}\``
      : "devicectl's process group has exited",
    ...(helperRuns
      ? [`check that \`ps -p ${helper.pid} -o command=\` shows console-run, then stop it with \`kill ${helper.pid}\``]
      : []),
  ];
  return Object.assign(new Error(`${detail} The device log claim stays at ${entry.claim.path}.`), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    remedy: `${steps.join('; ')}; then run ${claimRemoveCommand(entry.claim.path)}`.replace(/^./, (first) =>
      first.toUpperCase(),
    ),
  });
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  return done();
}

function exitOf(entry: ConsoleStream): { code: number | null; signal: string | null } | null {
  try {
    const exit: unknown = JSON.parse(readFileSync(consoleExitFile(entry.root, entry.id), 'utf8'));
    return isJsonObject(exit) && exit.helperPid === entry.helper.pid
      ? {
          code: typeof exit.code === 'number' ? exit.code : null,
          signal: typeof exit.signal === 'string' ? exit.signal : null,
        }
      : null;
  } catch {
    return null;
  }
}

/** Whether the console's helper recorded the console's end or is gone; it writes the exit just before it ends. */
export function consoleEnded(entry: ConsoleStream): boolean {
  if (exitOf(entry)) return true;
  const status = inspectProcessIdentity(entry.helper);
  return status === 'gone' || status === 'different';
}

/**
 * Starts the helper that runs `devicectl --console` for a physical iPhone and waits for it to report the console's
 * identity, which becomes the claim's child. The claim's details keep the helper, so a later stimd can take it over.
 * @ref LLP 0018#the-physical-iphone-consoles-helper -- stimd starts, stops and takes over the console's helper
 */
export async function startConsole({
  id,
  root,
  claim,
  udid,
  bundleId,
  payloadUrl,
  runId,
  attribution,
  env,
}: {
  id: string;
  root: string;
  claim: ClaimHandle;
  udid: string;
  bundleId: string;
  payloadUrl: string | null;
  runId: string | null;
  attribution: Record<string, unknown>;
  env: Record<string, string>;
}): Promise<ConsoleStream> {
  markClaimChildPending(claim);
  const logFile = helperLog(root, id);
  mkdirSync(dirname(logFile), { recursive: true });
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  const logFd = openSync(logFile, 'w', 0o600);
  let helperProcess: ChildProcess;
  try {
    helperProcess = getExecutor().spawn(
      process.execPath,
      [
        spawnEntry('console-run'),
        root,
        id,
        JSON.stringify({ runId, udid, bundleId, attribution }),
        '--',
        'xcrun',
        ...deviceConsoleArgs({ udid, bundleId, payloadUrl }),
      ],
      {
        cwd: root,
        env: { ...env, STIM_HOME: getConfigDir() },
        detached: true,
        stdio: ['ignore', logFd, logFd, 'ipc'],
      },
    );
  } catch (error) {
    releaseClaim(claim);
    throw error;
  } finally {
    closeSync(logFd);
  }
  const helperPid = helperProcess.pid;
  const helperToken = helperPid === undefined ? null : captureProcessToken(helperPid);
  const ended = new Promise<void>((done) => {
    helperProcess.once('exit', () => done());
    helperProcess.once('error', () => done());
  });
  const outcome = await new Promise<MetroRunMessage | 'ended' | 'timeout'>((done) => {
    const timer = setTimeout(() => done('timeout'), HANDSHAKE_MS);
    helperProcess.on('message', (message: unknown) => {
      if (!isJsonObject(message)) return;
      const identity = identityOf(message);
      if (message.type === 'registered' && identity) done({ type: 'registered', ...identity });
      else if (message.type === 'failed') done({ type: 'failed', message: String(message.message) });
      else return;
      clearTimeout(timer);
    });
    const onEnd = () => {
      clearTimeout(timer);
      done('ended');
    };
    helperProcess.once('exit', onEnd);
    helperProcess.once('error', onEnd);
  });
  if (typeof outcome === 'object' && outcome.type === 'registered' && helperPid !== undefined && helperToken) {
    const leader = { pid: outcome.pid, processToken: outcome.processToken };
    const helper = { pid: helperPid, processToken: helperToken };
    const engineDir = ownStoreEngine()?.build ?? null;
    const held =
      updateClaimDetails(claim, {
        ...claim.details,
        helper,
        engineDir,
        runId,
        attribution,
      }) ?? claim;
    setClaimChild(held, leader);
    helperProcess.send(CONSOLE_RUN_ACCEPT, () => {});
    helperProcess.unref();
    return {
      id,
      root,
      claim: held,
      helper,
      leader,
      runId,
      attribution,
      revision: 0,
      settling: null,
      refused: null,
    };
  }
  if (outcome === 'timeout' || (typeof outcome === 'object' && outcome.type === 'registered')) {
    if (
      helperPid !== undefined &&
      helperToken &&
      inspectProcessIdentity({ pid: helperPid, processToken: helperToken }) === 'same'
    )
      helperProcess.kill('SIGTERM');
    await Promise.race([ended, new Promise((done) => setTimeout(done, CONSOLE_STOP_MS + 3000))]);
  } else await ended;
  const still = helperProcess.exitCode === null && helperProcess.signalCode === null;
  if (typeof outcome === 'object' && outcome.type === 'failed' && !still) {
    releaseClaim(claim);
    rmSync(logFile, { force: true });
    throw new Error(`the device console did not start: ${outcome.message}`);
  }
  throw Object.assign(
    new Error(
      `The device console helper pid ${helperPid ?? 'unknown'} ${still ? 'did not report the console it started and still runs' : 'ended before it reported the console it started'}, so Stim cannot tell whether devicectl still runs. ${claim.path} stays held; its output is in ${logFile}.`,
    ),
    {
      code: 'STIM_CLAIM_UNAVAILABLE',
      remedy: `${still && helperPid !== undefined ? `Stop the helper with \`kill ${helperPid}\`, then check` : 'Check'} that no \`devicectl device process launch --console\` of this workspace still runs, then run ${pendingChildRemoveCommand(claim.path)} and retry.`,
    },
  );
}

/**
 * Settles a console whose helper ended: the helper wrote its closing records itself when it recorded the exit; a helper
 * that ended without one gets its devicectl group stopped and an error record. Then the stream's record and claim go.
 */
export async function settleConsole(entry: ConsoleStream): Promise<void> {
  const helperGone = () => ['gone', 'different'].includes(inspectProcessIdentity(entry.helper));
  await waitUntil(() => exitOf(entry) !== null || helperGone(), CONSOLE_STOP_MS + 3000);
  if (!exitOf(entry)) {
    const helper = inspectProcessIdentity(entry.helper);
    if (helper !== 'gone' && helper !== 'different')
      throw unverified(
        entry,
        `The device console helper pid ${entry.helper.pid} recorded no exit and its identity reads ${helper}, so Stim cannot tell whether it still writes the device log.`,
      );
    try {
      await stopProcessGroup(entry.leader, { termMs: CONSOLE_STOP_MS, label: GROUP });
    } catch (error) {
      throw unverified(entry, errorText(error));
    }
    let output = '';
    try {
      output = readFileSync(helperLog(entry.root, entry.id), 'utf8').slice(-4096).trim();
    } catch {}
    const writer = createNdjsonWriter(join(workspaceLogsDir(entry.root), 'device.ndjson'), {
      fields: {
        streamId: entry.id,
        ...(entry.runId ? { runId: entry.runId } : {}),
      },
    });
    writer.write({
      ...entry.attribution,
      src: 'device',
      platform: 'ios',
      level: 'error',
      event: 'collector_failed',
      msg: `the device console helper pid ${entry.helper.pid} ended without recording how devicectl pid ${entry.leader.pid} ended; treat the run as failed${output ? `. Its output:\n${output}` : ''}`,
    });
    writer.close();
  }
  unregisterStreamAll(entry.root, entry.id);
  if (!releaseClaim(entry.claim))
    throw new Error(`the device log claim at ${entry.claim.path} changed while the console was settled`);
  rmSync(consoleExitFile(entry.root, entry.id), { force: true });
  rmSync(helperLog(entry.root, entry.id), { force: true });
}

/** Asks the console's helper to stop devicectl and record it, then settles the entry. */
export async function stopConsole(entry: ConsoleStream): Promise<void> {
  if (!consoleEnded(entry))
    try {
      await stopHelperProcess(entry.helper, {
        graceMs: CONSOLE_STOP_MS + 3000,
        label: 'device console helper',
        stopGroup: () => stopProcessGroup(entry.leader, { termMs: CONSOLE_STOP_MS, label: GROUP }),
      });
    } catch (error) {
      throw unverified(entry, errorText(error));
    }
  await settleConsole(entry);
}

/** The claim holder of stream `streamId` that names a console helper, or null for any other stream. */
export function consoleHolder(root: string, streamId: string): ClaimHolder | null {
  const survey = readClaimSet(claimPath(root, streamId));
  return (
    [...survey.live, ...survey.dead].find(
      (holder) => holder.details.streamId === streamId && identityOf(holder.details.helper) !== null,
    ) ?? null
  );
}

/**
 * Takes over the console an earlier stimd started, from its claim: the holder's owner is gone, its child is devicectl
 * and its details name the helper. A console whose devicectl already ended is returned too, for the caller to settle.
 * Otherwise it returns why the claim could not be taken, with the claim and how to clear it.
 */
export function adoptConsole(root: string, streamId: string, holder: ClaimHolder): ConsoleStream | string {
  const helper = identityOf(holder.details.helper);
  const refusal = (why: string) =>
    `${why}. Verify that the helper${helper ? ` pid ${helper.pid}` : ''} and devicectl${holder.child ? ` (process group ${holder.child.pid})` : ''} have stopped, then run ${pendingChildRemoveCommand(holder.path)} and ${claimRemoveCommand(holder.path)}`;
  if (!helper) return refusal(`its claim at ${holder.path} names no helper`);
  if (!holder.child) return refusal(`its claim at ${holder.path} records no devicectl process`);
  const path = claimPath(root, streamId);
  const retaken = retakeClaim(holder, path, LABEL);
  const child = retaken ? 'same' : inspectProcessIdentity(holder.child);
  if (!retaken && (child === 'same' || child === 'unknown'))
    return refusal(
      `its claim at ${holder.path} could not be taken while devicectl pid ${holder.child.pid} reads ${child}`,
    );
  const claim = retaken ?? { ...holder, root: path, label: LABEL };
  return {
    id: streamId,
    root,
    claim,
    helper,
    leader: holder.child,
    runId: typeof holder.details.runId === 'string' ? holder.details.runId : null,
    attribution: isJsonObject(holder.details.attribution) ? holder.details.attribution : {},
    revision: 0,
    settling: null,
    refused: null,
  };
}
