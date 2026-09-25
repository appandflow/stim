import { readFileSync } from 'node:fs';
import { rotatedLogPath } from '../index.ts';

export interface NdjsonRecord {
  ts?: number;
  src?: string;
  level?: string;
  msg?: string;
  [key: string]: unknown;
}

export const LEVELS: string[] = ['debug', 'info', 'warn', 'error', 'fatal'];

export const SOURCES: string[] = ['metro', 'client', 'device', 'build'];

export function levelRank(level?: string): number {
  const i = LEVELS.indexOf(level as string);
  return i < 0 ? 0 : i;
}

export function parseNdjsonLine(line: unknown): NdjsonRecord | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as NdjsonRecord;
}

export function parseNdjsonText(text: unknown): NdjsonRecord[] {
  if (typeof text !== 'string' || text === '') return [];
  const out: NdjsonRecord[] = [];
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    const record = parseNdjsonLine(line);
    if (record) out.push(record);
  }
  return out;
}

export function readNdjsonGenerations(file: string): NdjsonRecord[] {
  const out: NdjsonRecord[] = [];
  for (const path of [rotatedLogPath(file), file]) {
    let text;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    for (const record of parseNdjsonText(text)) out.push(record);
  }
  return out;
}
