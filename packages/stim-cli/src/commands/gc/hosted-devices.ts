import type { StimContext } from '@stim-cli/core';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from '../../engine/spawn-claims.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertHostedDeviceLedger,
  deviceHostArea,
  deviceHostRoot,
  hostedDeviceId,
  isJsonObject,
  parseHostedPlatformDevice,
  readHostedDevice,
  readHostedDeviceLedger,
  readHostedSessions,
  type HostedDeviceSession,
} from '@stim-cli/core/state';
import {
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '../../ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from '../../process-identity.ts';
import { getExecutor } from '../../exec.ts';
import { listAvdsAsync } from '../../devices/android.ts';
import { describeError } from './eas-sessions.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';

export interface ParkedHostedDeviceReport {
  session: string;
  client: string;
  platform: 'ios' | 'android';
  id: string | null;
  name: string | null;
  parkedAt: string;
  listed: boolean | null;
}

export function collectParkedHostedDevices({
  olderThanDays = null,
  now = Date.now(),
}: { olderThanDays?: number | null; now?: number } = {}): { devices: ParkedHostedDeviceReport[]; notices: string[] } {
  const notices: string[] = [];
  let sessions: HostedDeviceSession[];
  try {
    try {
      statSync(join(deviceHostRoot(), 'sessions.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { devices: [], notices };
      throw error;
    }
    sessions = readHostedSessions();
  } catch (error) {
    return { devices: [], notices: [`Hosted session journal unreadable; devices kept: ${describeError(error)}`] };
  }
  const devices: ParkedHostedDeviceReport[] = [];
  for (const record of sessions) {
    if (!record.parked || record.platform === 'macos') continue;
    if (olderThanDays !== null && now - Date.parse(record.parked.at) < olderThanDays * 86_400_000) continue;
    const id = record.device ? hostedDeviceId(record.device) : null;
    let listed: boolean | null = null;
    try {
      const ledger = readHostedDeviceLedger(join(deviceHostArea(record.id), 'home'));
      listed = ledger !== null && id !== null && ledger[record.platform].includes(id);
    } catch (error) {
      notices.push(`Hosted session ${record.id} ledger unreadable; device kept: ${describeError(error)}`);
    }
    devices.push({
      session: record.id,
      client: record.client,
      platform: record.platform,
      id,
      name: record.device && 'name' in record.device ? record.device.name : id,
      parkedAt: record.parked.at,
      listed,
    });
  }
  return { devices, notices };
}

async function stopHostedDevice(record: HostedDeviceSession, claim: ClaimHandle, operation?: StimContext) {
  operation?.signal.throwIfAborted();
  const home = join(deviceHostArea(record.id), 'home');
  markClaimChildPending(claim);
  if (operation) declareSpawnsOn(operation, claim);
  let child;
  try {
    child = getExecutor().spawn(
      process.execPath,
      [join(dirname(fileURLToPath(import.meta.url)), 'device-host-worker.mjs')],
      {
        cwd: home,
        env: { ...(operation?.env ?? process.env), STIM_HOME: home },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    clearClaimChild(claim);
    return { settled: true, value: null, notice: describeError(error) };
  } finally {
    if (operation) stopDeclaringSpawnsOn(operation, claim);
  }
  let identity: ProcessRecord | null = null;
  let closed = false;
  let output = '';
  let stderr = '';
  let notice: string | undefined;
  let timer: NodeJS.Timeout;
  let killTimer: NodeJS.Timeout | undefined;
  let groupTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let cancelling = false;
  let finishTimer: NodeJS.Timeout | undefined;
  return await new Promise<{ settled: boolean; value: unknown; notice?: string }>((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(finishTimer);
      clearTimeout(groupTimer);
      operation?.signal.removeEventListener('abort', cancel);
      const settled = closed && (!child.pid || !processGroupAlive(child.pid));
      if (settled) clearClaimChild(claim);
      let value: unknown = null;
      try {
        value = JSON.parse(output);
      } catch {
        notice ??= stderr.trim() || 'Hosted worker returned no valid result.';
      }
      if (!settled) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      resolve({ settled, value, notice });
    };
    const signal = (name: NodeJS.Signals) => {
      if (child.pid && identity && ['same', 'gone'].includes(inspectProcessIdentity(identity))) {
        try {
          process.kill(-child.pid, name);
        } catch {}
      } else if (!identity) child.stdin?.destroy();
    };
    const cancel = () => {
      if (finished || cancelling) return;
      cancelling = true;
      notice ??= operation?.signal.aborted ? 'Hosted cleanup cancelled.' : 'Hosted worker exceeded its deadline.';
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), 5000);
      finishTimer = setTimeout(finish, 10_000);
    };
    const finishGroup = () => {
      if (finished) return;
      if (!child.pid || !processGroupAlive(child.pid)) finish();
      else {
        cancel();
        groupTimer = setTimeout(finishGroup, 25);
      }
    };
    timer = setTimeout(cancel, 90_000);
    operation?.signal.addEventListener('abort', cancel, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 16_384) {
        notice = 'Hosted worker output exceeded its bound.';
        cancel();
      } else output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    child.stdin?.on('error', () => cancel());
    child.once('error', (error) => {
      notice = error.message;
      closed = true;
      finishGroup();
    });
    child.once('close', (code) => {
      if (code !== 0) notice ??= stderr.trim() || `Hosted worker exited ${code}.`;
      closed = true;
      finishGroup();
    });
    const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
    if (!captured?.ok || child.pid === undefined) {
      notice = 'Hosted worker identity unavailable; no native request was sent.';
      cancel();
      return;
    }
    identity = { pid: child.pid, processToken: captured.token };
    try {
      setClaimChild(claim, identity);
      if (operation?.signal.aborted) {
        cancel();
        return;
      }
      child.stdin?.end(
        JSON.stringify({
          mode: 'stop',
          platform: record.platform,
          session: record.id,
          deviceType: record.deviceType,
          runtime: record.runtime,
          systemImage: record.systemImage,
          deviceProfile: record.deviceProfile,
          consolePort: record.consolePort,
        }),
      );
    } catch (error) {
      notice = describeError(error);
      cancel();
    }
  });
}

export async function deleteParkedHostedDevices(
  devices: readonly ParkedHostedDeviceReport[],
  { listAvds: list, operation }: { listAvds?: () => string[] | Promise<string[]>; operation?: StimContext } = {},
  output: GcOutput = GC_OUTPUT,
): Promise<number> {
  let failures = 0;
  for (const device of devices) {
    operation?.signal.throwIfAborted();
    if (device.listed === false) continue;
    const label = `${device.platform} ${device.name ?? device.session} (hosted session ${device.session})`;
    const kept = (detail: string) => {
      output.log(`Kept ${label}: ${detail}`);
      output.record('parkedHostedDevice', 'kept', label, { id: device.id, detail });
    };
    let claim: ClaimHandle | undefined;
    let settled = true;
    try {
      let attempt;
      try {
        attempt = tryAcquireClaim({
          root: join(deviceHostRoot(), `${device.session}.claims`),
          mode: 'exclusive',
          label: 'hosted device session',
          details: { session: device.session, client: device.client },
        });
      } catch (error) {
        kept(`session claim unavailable: ${describeError(error)}`);
        continue;
      }
      if (attempt.pending) releaseClaim(attempt.pending);
      claim = attempt.acquired;
      if (!claim) {
        kept('session claim is held by another process');
        continue;
      }
      const current = readHostedSessions().find((record) => record.id === device.session);
      if (
        !current?.parked ||
        current.client !== device.client ||
        current.parked.at !== device.parkedAt ||
        current.platform !== device.platform ||
        !current.device ||
        hostedDeviceId(current.device) !== device.id
      ) {
        kept('session is no longer the collected parked device');
        continue;
      }
      const home = join(deviceHostArea(current.id), 'home');
      try {
        assertHostedDeviceLedger(home, hostedDeviceId(current.device), device.platform);
        if (hostedDeviceId(readHostedDevice(home, device.platform)) !== device.id)
          throw new Error('The private device record no longer matches the session.');
      } catch (error) {
        kept(describeError(error));
        continue;
      }
      if (device.platform === 'android') {
        let avds: string[];
        if (operation) declareSpawnsOn(operation, claim);
        try {
          avds = await (list ? list() : listAvdsAsync({ operation, signal: operation?.signal }));
        } finally {
          if (operation) stopDeclaringSpawnsOn(operation, claim);
        }
        if (!avds.includes(device.id!)) {
          kept("AVD not visible from this shell's Android environment; run gc with the server's ANDROID_AVD_HOME/HOME");
          continue;
        }
      }
      operation?.signal.throwIfAborted();
      settled = false;
      const outcome = await stopHostedDevice(current, claim, operation);
      settled = outcome.settled;
      if (!settled)
        throw new WorkspaceProcessCleanupError(
          [claim],
          outcome.notice ?? 'Hosted cleanup could not be verified.',
          'Verify the hosted worker and its descendants have stopped.',
        );
      operation?.signal.throwIfAborted();
      const result = isJsonObject(outcome.value) ? outcome.value : null;
      const stopped = result && parseHostedPlatformDevice(result.device, device.platform);
      if (outcome.notice || result?.state !== 'stopped' || !stopped || hostedDeviceId(stopped) !== device.id)
        throw new Error(
          outcome.notice ??
            (typeof result?.notice === 'string' ? result.notice : 'Hosted deletion could not be verified.'),
        );
      output.log(`Deleted ${label}`);
      output.record('parkedHostedDevice', 'done', label, { id: device.id });
    } catch (error) {
      if (
        claim &&
        (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      ) {
        settled = false;
        throw Object.assign(
          new WorkspaceProcessCleanupError(
            [...new Set([claim, ...(error instanceof WorkspaceProcessCleanupError ? error.claims : [])])],
            error.message,
            'Verify the hosted device operation and its descendants have stopped.',
            error,
          ),
          { reportCleanup: true },
        );
      }
      operation?.signal.throwIfAborted();
      const detail = describeError(error);
      output.error(`Failed to delete ${label}: ${detail}`);
      output.record('parkedHostedDevice', 'failed', label, { id: device.id, detail });
      failures += 1;
    } finally {
      if (claim && settled) releaseClaim(claim);
    }
  }
  return failures;
}
