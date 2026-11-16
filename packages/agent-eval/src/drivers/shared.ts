import { accessSync, constants, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../trial.ts';
import type { TrialPaths } from '../types.ts';

export function minimalPath(paths: TrialPaths): string {
  return `${paths.bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

export function writeSkill(directory: string, skill: string): void {
  const file = join(directory, 'stim', 'SKILL.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, skill);
}

export function parseLines(transcript: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of transcript.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return events;
}

export function resolveBinary(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`${name} is not on PATH`);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function unwrapShell(command: string): string {
  const wrapped = /^(?:\/bin\/)?(?:zsh|bash|sh) -l?c (['"])([\s\S]*)\1$/.exec(command);
  return wrapped?.[2] ?? command;
}

export function checkoutReads(): string[] {
  const packages = join(REPO_ROOT, 'packages');
  return [
    join(REPO_ROOT, 'node_modules'),
    join(REPO_ROOT, 'package.json'),
    ...readdirSync(packages)
      .filter((name) => name !== 'agent-eval')
      .map((name) => join(packages, name)),
  ];
}
