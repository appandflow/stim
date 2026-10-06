import { isJsonObject, readJsonObject } from './json-file.ts';
import { setupJournalFile } from './paths.ts';

export type SetupCapability = 'build' | 'device-host';

export interface SetupJournal {
  v: 1;
  client: { nodeId: string };
  expiresAt: string;
  capabilities: SetupCapability[];
  steps: {
    id: string;
    state: 'pending' | 'running' | 'ok' | 'skipped' | 'failed';
    title: string;
    detail?: string;
    fix?: string;
  }[];
  granted: { capability: SetupCapability; id: string }[];
  done: boolean;
  exit?: number;
}

const capability = (value: unknown): value is SetupCapability => value === 'build' || value === 'device-host';
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const knownKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function parseSetupJournal(value: unknown): SetupJournal | null {
  if (
    !isJsonObject(value) ||
    !knownKeys(value, ['v', 'client', 'expiresAt', 'capabilities', 'steps', 'granted', 'done', 'exit']) ||
    value.v !== 1 ||
    !isJsonObject(value.client) ||
    !knownKeys(value.client, ['nodeId']) ||
    !text(value.client.nodeId) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(capability) ||
    !Array.isArray(value.steps) ||
    !value.steps.every(
      (step) =>
        isJsonObject(step) &&
        knownKeys(step, ['id', 'state', 'title', 'detail', 'fix']) &&
        text(step.id) &&
        typeof step.state === 'string' &&
        ['pending', 'running', 'ok', 'skipped', 'failed'].includes(step.state) &&
        text(step.title) &&
        (step.detail === undefined || typeof step.detail === 'string') &&
        (step.fix === undefined || typeof step.fix === 'string'),
    ) ||
    !Array.isArray(value.granted) ||
    !value.granted.every(
      (grant) =>
        isJsonObject(grant) && knownKeys(grant, ['capability', 'id']) && capability(grant.capability) && text(grant.id),
    ) ||
    typeof value.done !== 'boolean' ||
    (value.exit !== undefined && (!Number.isInteger(value.exit) || (value.exit as number) < 0))
  )
    return null;
  return value as unknown as SetupJournal;
}

export function readSetupJournal(hash: string): SetupJournal | null {
  const file = setupJournalFile(hash);
  return file === null ? null : parseSetupJournal(readJsonObject(file));
}

export function isJournalExpired(journal: SetupJournal, now: number = Date.now()): boolean {
  return Date.parse(journal.expiresAt) < now;
}

export function isSetupJournalPrunable(journal: SetupJournal, now: number): boolean {
  return Date.parse(journal.expiresAt) + 60 * 60_000 < now;
}
