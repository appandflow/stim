import { readFileSync } from 'node:fs';

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value = readJsonFile(path);
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}
