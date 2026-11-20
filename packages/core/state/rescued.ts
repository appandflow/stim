import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../index.ts';
import { isJsonObject, readJsonObject } from './json-file.ts';

/** Where cleanup copies what no rebuild or reinstall restores before it deletes the folder holding it. */
export function rescuedRoot(): string {
  return join(configDir(), 'rescued');
}

/** One copied file, by the path it had (`source`) and its path in the copy (`copy`). */
export interface RescuedItem {
  source: string;
  copy: string;
  size: number;
}

/** One rescue: its folder `dir`, the folder whose deletion it preceded (`from`), and when (`at`, epoch ms). */
export interface RescuedCopy {
  dir: string;
  from: string;
  at: number;
  items: RescuedItem[];
}

/** The rescues under `rescuedRoot()`, from their `manifest.json`; a folder without a readable manifest is left out. */
export function readRescuedCopies(): RescuedCopy[] {
  return names(rescuedRoot()).flatMap((workspace) =>
    names(join(rescuedRoot(), workspace)).flatMap((stamp): RescuedCopy[] => {
      const dir = join(rescuedRoot(), workspace, stamp);
      const manifest = readJsonObject(join(dir, 'manifest.json'));
      const { from, at, items } = manifest ?? {};
      if (typeof from !== 'string' || typeof at !== 'number' || !Array.isArray(items)) return [];
      return [{ dir, from, at, items: items.filter(isItem) }];
    }),
  );
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isItem(value: unknown): value is RescuedItem {
  if (!isJsonObject(value)) return false;
  const { source, copy, size } = value;
  return typeof source === 'string' && typeof copy === 'string' && typeof size === 'number';
}
