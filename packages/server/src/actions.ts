import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import { ACTIONS, type ActionName, type ActionParams, type ErrorCode, type ProtocolError } from './protocol.ts';
import { serverDir } from './registry.ts';
import type { CommandOutcome } from './stim-command.ts';

export type ParsedAction =
  | { action: ActionParams }
  | { code: Extract<ErrorCode, 'unknown-action' | 'bad-request'>; message: string };

export function parseAction(params: unknown): ParsedAction {
  if (!isJsonObject(params)) return { code: 'bad-request', message: 'params must be an object.' };
  const { action, workspace, platform, ...rest } = params;
  if (typeof action !== 'string' || !ACTIONS.includes(action as ActionName)) {
    return {
      code: 'unknown-action',
      message: `Unknown action ${JSON.stringify(action)}. Actions: ${ACTIONS.join(', ')}.`,
    };
  }
  if (typeof workspace !== 'string') {
    return { code: 'bad-request', message: 'params.workspace must be an environment path from a status payload.' };
  }
  const extra = Object.keys(rest);
  if (action === 'stop' && platform !== undefined) extra.push('platform');
  if (extra.length) return { code: 'bad-request', message: `${action} does not take ${extra.join(', ')}.` };
  if (action === 'stop') return { action: { action, workspace } };
  if (platform !== undefined && platform !== 'ios' && platform !== 'android') {
    return { code: 'bad-request', message: 'platform must be ios or android.' };
  }
  return { action: { action: 'reload', workspace, ...(platform ? { platform } : {}) } };
}

export function actionArgs(action: ActionParams): string[] {
  if (action.action === 'stop') return ['stop', '--json'];
  return ['reload', ...(action.platform ? [action.platform] : []), '--json'];
}

/** The JSON object the command printed, and on failure the message and remedy it printed, if any. */
export function actionOutcome(
  outcome: CommandOutcome,
): { ok: true; output: Record<string, unknown> } | { ok: false; error: ProtocolError } {
  let printed: unknown = null;
  try {
    printed = JSON.parse(outcome.stdout?.trim() ?? '');
  } catch {
    printed = null;
  }
  if (outcome.ok) {
    return isJsonObject(printed)
      ? { ok: true, output: printed }
      : {
          ok: false,
          error: { code: 'action-failed', message: 'The command printed output that is not a JSON object.' },
        };
  }
  if (isJsonObject(printed) && typeof printed.message === 'string') {
    const code = typeof printed.code === 'string' ? `${printed.code}: ` : '';
    const remedy = typeof printed.remedy === 'string' ? ` ${printed.remedy}` : '';
    return { ok: false, error: { code: 'action-failed', message: `${code}${printed.message}${remedy}` } };
  }
  return { ok: false, error: { code: 'action-failed', message: outcome.message } };
}

export interface AuditRecord {
  at: string;
  device: { id: string; name: string };
  action: string | null;
  workspace: string | null;
  platform?: string;
  ok: boolean;
  error?: ProtocolError;
  durationMs?: number;
  /** Why a control session ended, when the server ended it. */
  reason?: string;
}

function auditFile(): string {
  return join(serverDir(), 'actions.ndjson');
}

export function appendAudit(record: AuditRecord): void {
  mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
  appendFileSync(auditFile(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readAudit(): AuditRecord[] {
  let text: string;
  try {
    text = readFileSync(auditFile(), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isJsonObject(value) ? [value as unknown as AuditRecord] : [];
    } catch {
      return [];
    }
  });
}
