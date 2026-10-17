import { StringDecoder } from 'node:string_decoder';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { StimContext } from '@stim-cli/core';
import { getExecutor, isTimeoutError } from '../exec.ts';
import { createLineReader } from '../process-output.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { childEnvironment } from '../workspace/git-read.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { join } from 'node:path';
import { operationState, withDrainingCancellation } from './operation-state.ts';
import { WorkspaceProcessCleanupError } from './workspace-process-lock.ts';

/** Each request loads its own plugin module; module globals are not shared between phases. */
export interface LegacyCacheProvider {
  legacyPlugin: string;
  projectRoot: string;
  options: Record<string, unknown>;
}

interface LegacyCacheResult {
  available?: true;
  appPath?: string;
  uploaded?: true;
  destination?: string;
  failed?: string;
  timedOut?: true;
  skipped?: true;
}

export interface LegacyCacheRequest {
  phase: 'inspect' | 'resolve' | 'upload';
  provider: LegacyCacheProvider;
  platform?: string | null;
  fingerprintHash?: string | null;
  buildPath?: string | null;
  runOptions?: Record<string, unknown> | null;
  timeoutMs: number;
}

type WorkerMessage =
  | { kind: 'log'; record: unknown }
  | { kind: 'note'; line: string }
  | { kind: 'result'; value: LegacyCacheResult | null };

export async function legacyCacheWorker(
  request: LegacyCacheRequest,
  {
    context,
    logWriter,
    note,
  }: { context?: StimContext; logWriter?: Pick<NdjsonWriter, 'write'> | null; note?: (line: string) => void } = {},
): Promise<LegacyCacheResult | null> {
  const controller = new AbortController();
  const signals = [controller.signal];
  if (context) {
    signals.push(context.signal);
    const run = operationState(context).runSignal;
    if (run) signals.push(run);
  }
  const signal = AbortSignal.any(signals);
  let result: LegacyCacheResult | null | undefined;
  let ownWriter: NdjsonWriter | undefined;
  let outputFailure: { error: unknown } | undefined;
  let directory: string | undefined;
  let journal: number | undefined;
  let watcher: FSWatcher | undefined;
  let retainJournal = false;
  let offset = 0;
  let queued: NodeJS.Immediate | undefined;
  let finishing = false;
  const buffer = Buffer.alloc(8 * 1024);
  const protocol = new StringDecoder('utf8');
  const stdout = new StringDecoder('utf8');
  const stderr = new StringDecoder('utf8');
  const forward = (line: string) => {
    if (signal.aborted) return;
    try {
      context?.output('stderr', `${line}\n`);
    } catch (error) {
      outputFailure ??= { error };
      controller.abort(error);
    }
  };
  const output = createLineReader(forward);
  const errors = createLineReader(forward);
  const messages = createLineReader((line) => {
    let message: WorkerMessage;
    try {
      message = JSON.parse(line);
    } catch {
      controller.abort(new Error('The legacy cache worker returned invalid JSON.'));
      return;
    }
    if (!message || typeof message !== 'object') {
      controller.abort(new Error('The legacy cache worker returned an invalid message.'));
      return;
    }
    if (message.kind === 'result') {
      if (message.value === null || (typeof message.value === 'object' && !Array.isArray(message.value)))
        result = message.value;
      else controller.abort(new Error('The legacy cache worker returned an invalid result.'));
    } else if (signal.aborted) return;
    else if (message.kind === 'note' && typeof message.line === 'string') {
      try {
        if (note) note(message.line);
        else context?.output('stderr', `${message.line}\n`);
      } catch (error) {
        outputFailure ??= { error };
        controller.abort(error);
      }
    } else if (message.kind === 'log') {
      try {
        if (!logWriter && request.platform)
          ownWriter ??= createNdjsonWriter(
            join(workspaceLogsDir(request.provider.projectRoot), `build-${request.platform}.ndjson`),
          );
        (logWriter ?? ownWriter)?.write(message.record);
      } catch {}
    }
  });
  const readMessages = (end = Infinity): boolean => {
    try {
      if (journal === undefined || offset >= end) return false;
      const length = Math.min(buffer.length, end - offset);
      const bytes = readSync(journal, buffer, 0, length, offset);
      offset += bytes;
      messages.push(protocol.write(buffer.subarray(0, bytes)));
      return bytes === length && offset < end;
    } catch (error) {
      controller.abort(error);
      return false;
    }
  };
  const scheduleRead = () => {
    if (finishing || queued) return;
    queued = setImmediate(() => {
      queued = undefined;
      if (!finishing && readMessages()) scheduleRead();
    });
  };
  try {
    directory = mkdtempSync(join(tmpdir(), 'stim-legacy-cache-'));
    const messagesPath = join(directory, 'messages.ndjson');
    writeFileSync(messagesPath, '', { mode: 0o600 });
    journal = openSync(messagesPath, 'r');
    watcher = watch(messagesPath, { persistent: false }, scheduleRead);
    watcher.on('error', (error) => controller.abort(error));
    try {
      await withDrainingCancellation(context, signal, () =>
        getExecutor().runFileAsync(process.execPath, [spawnEntry('legacy-cache')], {
          timeoutMs: request.timeoutMs,
          cwd: request.provider.projectRoot,
          ...(context ? childEnvironment(context.env) : {}),
          input: JSON.stringify({ ...request, messagesPath }),
          signal,
          declareFor: context,
          containProcessTree: true,
          cleanupOnExit: true,
          onSpawn(child) {
            child.stdout?.on('data', (chunk: Buffer) => output.push(stdout.write(chunk)));
            child.stderr?.on('data', (chunk: Buffer) => errors.push(stderr.write(chunk)));
          },
        }),
      );
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      finishing = true;
      watcher.close();
      clearImmediate(queued);
      try {
        const end = fstatSync(journal).size;
        while (readMessages(end)) await nextTurn();
      } catch (error) {
        controller.abort(error);
      }
      messages.push(protocol.end());
      messages.flush();
      output.push(stdout.end());
      output.flush();
      errors.push(stderr.end());
      errors.flush();
    }
    if (outputFailure) throw outputFailure.error;
    signal.throwIfAborted();
    if (result === undefined) throw new Error('The legacy cache worker exited without a result.');
    return result;
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error)) {
      retainJournal = true;
      if (directory) error.message += ` Worker messages remain at ${directory}.`;
      throw error;
    }
    if (outputFailure) throw outputFailure.error;
    context?.signal.throwIfAborted();
    operationState(context).runSignal?.throwIfAborted();
    if (isTimeoutError(error)) return { timedOut: true };
    return {
      failed:
        String(error instanceof Error ? error.message : error)
          .split('\n')[0]
          ?.slice(0, 200) || 'Legacy cache worker failed',
    };
  } finally {
    finishing = true;
    clearImmediate(queued);
    watcher?.close();
    if (journal !== undefined) {
      closeSync(journal);
      journal = undefined;
    }
    if (directory && !retainJournal) rmSync(directory, { recursive: true, force: true });
    ownWriter?.close();
  }
}
