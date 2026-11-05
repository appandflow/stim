import { acquireBuildSlot, releaseBuildSlot, type BuildSlotHandle } from '../engine/build-slots.ts';
import { existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, type StimContext } from '@stim-cli/core';
import { cancellableSleep } from '../cancellation.ts';
import { getExecutor } from '../exec.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import {
  claimFailure,
  clearClaimChild,
  markClaimChildPending,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { captureProcessIdentity } from '../process-identity.ts';
import { createLineReader, stripAnsi } from '../process-output.ts';
import { iosRuntimeMatches, listIosRuntimesAsync } from './ios.ts';

const INSTALL_TIMEOUT_MS = 30 * 60_000;
const REQUIRED_FREE_BYTES = 20 * 1024 ** 3;
const RUNTIME_VERSION = /^(?:iOS )?(\d+\.\d+(?:\.\d+)?)$/;

export type IosRuntimeInstallResult = { ok: true } | { ok: false; code: string; message: string; remedy: string };

const refuse = (message: string, remedy: string): IosRuntimeInstallResult => ({
  ok: false,
  code: 'STIM_NO_DEVICE',
  message,
  remedy,
});

/** Installs only an explicit missing iOS version; runtimes remain shared Xcode components, never Stim-owned devices. */
export async function ensureIosRuntime({
  requested,
  signal,
  operation,
  workerProcessGroup,
  note,
}: {
  requested: string;
  signal?: AbortSignal;
  operation?: StimContext;
  /** The server owns this worker as a process-group leader and settles its entire group before replying. */
  workerProcessGroup?: true;
  note: (line: string) => void;
}): Promise<IosRuntimeInstallResult> {
  const version = RUNTIME_VERSION.exec(requested)?.[1];
  if (!version)
    return {
      ok: false,
      code: 'STIM_BAD_ARG',
      message: 'Runtime installation needs an exact iOS version, such as 26.5 or iOS 26.5.',
      remedy: 'Pass --runtime <major.minor[.patch]>.',
    };
  const installed = async () =>
    (await listIosRuntimesAsync({ signal, operation })).some((runtime) => iosRuntimeMatches(runtime, requested));
  if (await installed()) return { ok: true };
  if (process.platform !== 'darwin')
    return refuse('iOS runtimes can be installed only on a Mac.', 'Use --remote <mac> with an approved Mac.');
  const manual = `xcodebuild -downloadPlatform iOS -buildVersion ${version} -architectureVariant ${process.arch === 'arm64' ? 'arm64' : 'universal'}`;
  const root = join(configDir(), 'ios-runtime-install');
  let held: ClaimHandle | undefined;
  let waited = false;
  while (!held) {
    signal?.throwIfAborted();
    try {
      const attempt = tryAcquireClaim({
        root,
        mode: 'exclusive',
        label: 'iOS runtime install',
        details: { runtime: version },
      });
      held = attempt.acquired;
      if (attempt.pending) releaseClaim(attempt.pending);
    } catch (error) {
      const failure = claimFailure(error, null);
      if (failure) return { ok: false, ...failure };
      throw error;
    }
    if (!held) {
      if (!waited) note('Waiting for another Stim iOS runtime installation on this Mac.');
      waited = true;
      await cancellableSleep(2000, { signal, what: 'iOS runtime installation' });
    }
  }
  const claim = held;
  let unresolved = false;
  let workerChild = false;
  let slot: BuildSlotHandle | undefined;
  try {
    if (await installed()) return { ok: true };
    const volume = existsSync('/Library/Developer/CoreSimulator') ? '/Library/Developer/CoreSimulator' : '/Library';
    let free: number;
    try {
      const disk = statfsSync(volume);
      free = disk.bavail * disk.bsize;
    } catch (error) {
      return refuse(
        `Cannot establish free disk space on ${volume}: ${error instanceof Error ? error.message : String(error)}`,
        'Check free space on the Mac before installing the runtime through Xcode.',
      );
    }
    if (free < REQUIRED_FREE_BYTES)
      return refuse(
        `${(free / 1024 ** 3).toFixed(1)} GB free on ${volume}; installing iOS ${version} requires at least 20 GB for download and unpacking.`,
        'Free space on that volume, then retry. Stim does not delete shared runtimes.',
      );
    slot = await acquireBuildSlot({ signal, out: note });
    note(
      `Installing iOS ${version} with Xcode (typically 8-10 GB; actual size varies). This runtime is shared by every workspace on this Mac.`,
    );
    const reader = createLineReader((line) => {
      if (line.trim()) note(stripAnsi(line).replace(/\r/g, '\n').slice(-1000));
    });
    const heartbeat = setInterval(
      () => note(`Still installing iOS ${version}; Xcode downloads can take several minutes.`),
      30_000,
    );
    heartbeat.unref();
    try {
      markClaimChildPending(held);
      if (slot?.claim) markClaimChildPending(slot.claim);
      await runOperationFile(
        operation,
        getExecutor(),
        'xcodebuild',
        [
          '-downloadPlatform',
          'iOS',
          '-buildVersion',
          version,
          '-architectureVariant',
          process.arch === 'arm64' ? 'arm64' : 'universal',
        ],
        {
          timeoutMs: INSTALL_TIMEOUT_MS,
          signal,
          containProcessTree: true,
          onSpawn: (child) => {
            if (child.pid === undefined) return;
            if (workerProcessGroup) {
              workerChild = true;
              setClaimChild(claim, claim.owner);
              if (slot?.claim) setClaimChild(slot.claim, claim.owner);
            } else {
              const captured = captureProcessIdentity(child.pid);
              if (!captured.ok) throw new Error(`Cannot record the Xcode runtime installer: ${captured.reason}`);
              const identity = { pid: child.pid, processToken: captured.token };
              setClaimChild(claim, identity);
              if (slot?.claim) setClaimChild(slot.claim, identity);
            }
            child.stdout?.on('data', (chunk) => reader.push(String(chunk).replace(/\r/g, '\n')));
            child.stderr?.on('data', (chunk) => reader.push(String(chunk).replace(/\r/g, '\n')));
          },
        },
      );
    } catch (error) {
      if (error instanceof Error && 'reportCleanup' in error) {
        unresolved = true;
        throw error;
      }
      signal?.throwIfAborted();
      return refuse(
        `Xcode could not install iOS ${version}: ${(error instanceof Error ? error.message : String(error)).slice(-4000)}`,
        `Run \`${manual}\` on the simulator Mac for the full error. Xcode Settings > Components lists versions supported by its selected Xcode; update Xcode if the requested runtime is unsupported.`,
      );
    } finally {
      clearInterval(heartbeat);
      reader.flush();
      if (!unresolved && !workerChild) clearClaimChild(held);
    }
    if (!(await installed()))
      return refuse(
        `Xcode finished but iOS ${version} is not available in simctl.`,
        `Run \`xcrun simctl list runtimes\` and \`${manual}\` on the simulator Mac to inspect the installation.`,
      );
    note(
      `iOS ${version} is installed. Remove shared runtimes manually in Xcode Settings > Components when no workspace needs them.`,
    );
    return { ok: true };
  } finally {
    if (!unresolved && !workerChild) {
      releaseBuildSlot(slot);
      releaseClaim(held);
    }
  }
}
