import { existsSync, readFileSync, readdirSync, type Dirent } from 'fs';
import { join } from 'path';
import { readProjectConfig } from '../engine/remote-cache.ts';
import { readAppConfigText } from './project.ts';

function configString(config: unknown, platform: 'ios' | 'android', key: string): string | null {
  if (!config || typeof config !== 'object') return null;
  const expoField = (config as { expo?: unknown }).expo;
  const exp = (expoField && typeof expoField === 'object' ? expoField : config) as Record<string, unknown>;
  const section = exp[platform];
  if (!section || typeof section !== 'object') return null;
  const value = (section as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

function detectFromConfig(projectRoot: string, platform: 'ios' | 'android', key: string): string | null {
  const read = readProjectConfig(projectRoot);
  if (!read.unavailable) return configString(read.config, platform, key);
  const text = readAppConfigText(projectRoot);
  return text?.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`))?.[1] ?? null;
}

export function detectBundleId(projectRoot: string): string | null {
  return detectFromConfig(projectRoot, 'ios', 'bundleIdentifier') ?? detectBundleIdFromPbxproj(projectRoot);
}

export function detectAndroidPackage(projectRoot: string): string | null {
  return detectFromConfig(projectRoot, 'android', 'package') ?? detectAndroidPackageFromGradle(projectRoot);
}

function detectBundleIdFromPbxproj(projectRoot: string): string | null {
  const iosDir = join(projectRoot, 'ios');
  if (!existsSync(iosDir)) return null;
  let entries: Dirent[];
  try {
    entries = readdirSync(iosDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.xcodeproj')) continue;
    const pbx = join(iosDir, entry.name, 'project.pbxproj');
    if (!existsSync(pbx)) continue;
    let text: string;
    try {
      text = readFileSync(pbx, 'utf-8');
    } catch {
      continue;
    }
    const all = [...text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s"]+)\s*;/g)].map((m) => m[1]);
    const concrete = all.filter((id): id is string => !!id && !id.startsWith('$') && !id.includes('('));
    if (concrete.length === 0) continue;
    const counts: Record<string, number> = {};
    for (const id of concrete) counts[id] = (counts[id] || 0) + 1;
    let best: string | null = null,
      bestCount = 0,
      bestLen = Infinity;
    for (const [id, count] of Object.entries(counts)) {
      if (count > bestCount || (count === bestCount && id.length < bestLen)) {
        best = id;
        bestCount = count;
        bestLen = id.length;
      }
    }
    return best;
  }
  return null;
}

function detectAndroidPackageFromGradle(projectRoot: string): string | null {
  const gradle = join(projectRoot, 'android', 'app', 'build.gradle');
  if (!existsSync(gradle)) return null;
  let text: string;
  try {
    text = readFileSync(gradle, 'utf-8');
  } catch {
    return null;
  }
  const ns = text.match(/namespace\s+["']([^"']+)["']/);
  const nsId = ns?.[1];
  if (nsId) return nsId;
  const app = text.match(/applicationId\s+["']([^"']+)["']/);
  const appId = app?.[1];
  if (appId) return appId;
  return null;
}
