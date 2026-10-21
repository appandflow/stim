import type { StimContext } from '@stim-cli/core';
import {
  openLogDir,
  logFiles,
  followLogs,
  buildCriteria,
  recordMatches,
  readMacosRecord,
  type LogDir,
  type NdjsonRecord,
  compileGrep,
  parseSince,
  SOURCES,
  LEVELS,
} from '@stim-cli/core/state';
import { createAsyncAgentActionReader, workspaceAgentTargets } from '../devices/agent-actions.ts';
import { followAgentActions } from '../devices/agent-actions-follow.ts';
import { captureWorkspaceCrashes } from '../diagnostics/native-crash.ts';
import { syncHostedLogs, followHostedLogs } from '../device-host/hosted-logs-sync.ts';
import { loadConfig } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import type { StimLogsOptions } from '../api/types.ts';

export interface WorkspaceLogs {
  view: LogDir;
  readAgent: ReturnType<typeof createAsyncAgentActionReader> | null;
  hostedReachable: boolean;
}

export async function openWorkspaceLogs(
  context: StimContext,
  options: StimLogsOptions = {},
  follow = false,
): Promise<WorkspaceLogs> {
  context.signal.throwIfAborted();
  const root = context.projectRoot;
  const dir = workspaceLogsDir(root);
  if (!logFiles(dir).length)
    throw Object.assign(
      new Error(`No Stim workspace has run in ${root}. Run stim start, stim ios, or stim android in the app first.`),
      { code: 'STIM_NO_PROJECT' },
    );
  const hostedReachable = await syncHostedLogs(root, context);
  context.signal.throwIfAborted();
  const initial = await openLogDir(dir, { signal: context.signal });
  let attempts: NdjsonRecord[];
  try {
    attempts = initial.launchAttempts();
  } finally {
    await initial.close();
  }
  await captureWorkspaceCrashes(root, dir, attempts, context.signal, context.env);
  const view = await openLogDir(dir, { order: follow ? 'name' : 'timeline', signal: context.signal });
  const agentSince = view.firstTs ?? (follow ? Date.now() : undefined);
  const project = loadConfig()?.projects?.[root];
  const readAgent =
    (options.sources ? options.sources.includes('agent') : !options.errorsOnly) && agentSince !== undefined
      ? createAsyncAgentActionReader(
          {
            targets: () => workspaceAgentTargets(project, readMacosRecord(root)),
            sinceTs: agentSince,
            home: context.env.HOME,
            env: context.env,
          },
          context.signal,
        )
      : null;
  return { view, readAgent, hostedReachable };
}

export async function readWorkspaceLogs(context: StimContext, options: StimLogsOptions = {}): Promise<NdjsonRecord[]> {
  validateLogOptions(options);
  const { view, readAgent } = await openWorkspaceLogs(context, options);
  try {
    return await view.query({
      ...options,
      extra: await readAgent?.({ tail: options.tail, matches: view.filter(options) }),
    });
  } finally {
    await view.close();
  }
}

function validateLogOptions(options: StimLogsOptions): void {
  const bad =
    options.tail !== undefined && (!Number.isSafeInteger(options.tail) || options.tail < 0)
      ? 'tail must be a non-negative integer.'
      : options.sources?.some((source) => !SOURCES.includes(source))
        ? `sources must contain only ${SOURCES.join(', ')}.`
        : options.minLevel !== undefined && !LEVELS.includes(options.minLevel)
          ? `minLevel must be one of ${LEVELS.join(', ')}.`
          : undefined;
  const invalid =
    bad ??
    (options.since !== undefined ? parseSince(options.since).error : undefined) ??
    (options.grep !== undefined ? compileGrep(options.grep).error : undefined);
  if (invalid) throw Object.assign(new Error(invalid), { code: 'STIM_BAD_ARG' });
}

export async function followWorkspaceLogs(
  context: StimContext,
  options: StimLogsOptions,
  onRecord: (record: NdjsonRecord) => void,
  onBackfill?: (records: readonly NdjsonRecord[]) => Promise<void>,
): Promise<() => void> {
  validateLogOptions(options);
  const { view, readAgent, hostedReachable } = await openWorkspaceLogs(context, options, true);
  try {
    const query = {
      ...options,
      extra: await readAgent?.({ tail: options.tail, matches: view.filter(options) }),
    };
    if (onBackfill && options.tail === undefined) {
      for await (const batch of view.batches(query)) {
        await onBackfill(batch);
        context.signal.throwIfAborted();
      }
    } else {
      const records = await view.query(query);
      context.signal.throwIfAborted();
      if (onBackfill) await onBackfill(records);
      else for (const record of records) onRecord(record);
    }
  } catch (error) {
    await view.close();
    throw error;
  }
  const criteria = buildCriteria(options);
  const stopLog = followLogs({
    dir: workspaceLogsDir(context.projectRoot),
    offsets: view.sizes,
    identities: view.identities,
    criteria,
    onRecord,
    errorContext: options.errorsOnly ? 'field' : undefined,
  });
  await view.close();
  const stopAgent = readAgent
    ? followAgentActions(context, readAgent, (record) => {
        if (recordMatches(record, criteria)) onRecord(record);
      })
    : null;
  const stopHosted = followHostedLogs(context.projectRoot, !hostedReachable, context);
  const stop = () => {
    stopLog();
    stopHosted();
    stopAgent?.();
    context.signal.removeEventListener('abort', stop);
  };
  context.signal.addEventListener('abort', stop, { once: true });
  if (context.signal.aborted) stop();
  return stop;
}
