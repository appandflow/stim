import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  claimRemoveCommand,
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from '@stim-cli/core/process-identity';
import { isJsonObject } from '@stim-cli/core/state';
import type { BuildArtifactIdentity, BuildGradleArtifactQuery, BuildReactNativeArtifactQuery } from './protocol.ts';

export interface ArtifactQueryResult {
  identity: BuildArtifactIdentity | null;
  settled: boolean;
}

/** Revalidates only a completed build's private inputs, holding its area until the owned query has stopped. */
export function runArtifactQuery({
  worker,
  area,
  env,
  query,
  receipt,
  signal,
  timeoutMs = 10_000,
  killGraceMs = 1000,
}: {
  worker: string;
  area: string;
  env: NodeJS.ProcessEnv;
  query: BuildGradleArtifactQuery | BuildReactNativeArtifactQuery;
  receipt: unknown;
  signal: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
}): { done: Promise<ArtifactQueryResult>; cancel: () => void } {
  signal.throwIfAborted();
  const attempt = tryAcquireClaim({ root: `${area}.claims`, mode: 'shared', label: 'Completed artifact query' });
  if (!attempt.acquired) {
    if (attempt.pending) releaseClaim(attempt.pending);
    return { done: Promise.resolve({ identity: null, settled: true }), cancel: () => {} };
  }
  const claim = attempt.acquired;
  markClaimChildPending(claim);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      [worker, 'sourceDigest' in query ? 'native-gradle-artifact' : 'react-native-artifact'],
      {
        cwd: area,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    clearClaimChild(claim);
    releaseClaim(claim);
    throw error;
  }
  let identity: ProcessRecord | null = null;
  let closed = false;
  let ended = false;
  let stopped = false;
  let output = '';
  let treeStopped: Promise<boolean> | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let groupTimer: NodeJS.Timeout | undefined;
  let finish!: (result: ArtifactQueryResult) => void;
  const done = new Promise<ArtifactQueryResult>((resolve) => {
    finish = resolve;
  });
  const end = (settled: boolean) => {
    if (ended) return;
    ended = true;
    clearTimeout(deadline);
    clearTimeout(killTimer);
    clearTimeout(settleTimer);
    clearTimeout(groupTimer);
    signal.removeEventListener('abort', cancel);
    let result: BuildArtifactIdentity | null = null;
    if (settled) {
      try {
        clearClaimChild(claim);
        releaseClaim(claim);
      } catch (error) {
        settled = false;
        console.error(`stim-server: Completed artifact query could not release ${claim.path}: ${String(error)}`);
      }
      if (settled && !stopped) {
        try {
          const value: unknown = JSON.parse(output);
          if (
            isJsonObject(value) &&
            isJsonObject(value.identity) &&
            typeof value.identity.hash === 'string' &&
            /^[a-f0-9]{64}$/.test(value.identity.hash) &&
            typeof value.identity.key === 'string' &&
            value.identity.key.length > 0 &&
            value.identity.key.length <= 1024
          )
            result = { fingerprint: value.identity.hash, cacheKey: value.identity.key };
        } catch {}
      }
    }
    if (!settled) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      console.error(
        `stim-server: Completed artifact query cleanup is unresolved at ${claim.path}; inspect before ${claimRemoveCommand(claim.root)}`,
      );
    }
    finish({ identity: result, settled });
  };
  const signalGroup = (name: NodeJS.Signals) => {
    if (!identity || !child.pid) return;
    const status = inspectProcessIdentity(identity);
    if (status !== 'same' && status !== 'gone') return;
    if (process.platform === 'win32') {
      treeStopped ??= new Promise<boolean>((resolve) => {
        execFile(
          join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { timeout: 4000 },
          (error) => resolve(!error),
        );
      });
    } else {
      try {
        process.kill(-child.pid, name);
      } catch {}
    }
  };
  const cancel = () => {
    if (ended || stopped) return;
    stopped = true;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), killGraceMs);
    settleTimer = setTimeout(() => end(false), killGraceMs + 5000);
  };
  const drained = async () => {
    if (ended || !closed) return;
    if (treeStopped && !(await treeStopped)) return end(false);
    if (!child.pid || !processGroupAlive(child.pid)) return end(true);
    cancel();
    groupTimer = setTimeout(() => void drained(), 25);
  };
  const deadline = setTimeout(cancel, timeoutMs);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 16_384) cancel();
    else output += chunk;
  });
  child.stderr?.resume();
  child.stdin?.on('error', cancel);
  child.once('error', () => {
    cancel();
    closed = true;
    void drained();
  });
  child.once('close', (code) => {
    if (code !== 0) cancel();
    closed = true;
    void drained();
  });
  signal.addEventListener('abort', cancel, { once: true });
  const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
  if (!captured?.ok || child.pid === undefined) {
    child.kill('SIGKILL');
    cancel();
  } else {
    identity = { pid: child.pid, processToken: captured.token };
    try {
      setClaimChild(claim, identity);
      if (signal.aborted) cancel();
      else
        child.stdin?.end(
          JSON.stringify({
            root: join(area, 'src', query.project),
            receipt,
            ...('sourceDigest' in query
              ? { sourceDigest: query.sourceDigest, inputs: query.inputs, android: query.android }
              : { query }),
          }),
        );
    } catch (error) {
      console.error(`stim-server: Completed artifact query could not record its child: ${String(error)}`);
      cancel();
    }
  }
  return { done, cancel };
}
