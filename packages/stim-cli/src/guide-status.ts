import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir, getProject, upsertProject } from './config.ts';
import type { DoctorPlatform } from './doctor.ts';
import { compareStimVersions } from './stim-installations.ts';
import type { DoctorRunRecord } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DOCTOR_STALE_MS = 7 * DAY_MS;
const UPDATE_CHECK_INTERVAL_MS = DAY_MS;
const UPDATE_CHECK_TIMEOUT_MS = 2000;
const LATEST_URL = 'https://registry.npmjs.org/stim/latest';
const PLATFORMS: DoctorPlatform[] = ['ios', 'android'];

export function recordDoctorRun(
  projectRoot: string,
  platform: DoctorPlatform | undefined,
  version: string,
  now: Date = new Date(),
): void {
  const run: DoctorRunRecord = { at: now.toISOString(), version };
  const doctorRuns = { ...getProject(projectRoot)?.doctorRuns };
  for (const target of platform ? [platform] : PLATFORMS) doctorRuns[target] = run;
  upsertProject(projectRoot, { doctorRuns });
}

export function doctorDueReason(record: DoctorRunRecord | undefined, running: string, now: Date): string | null {
  const at = record ? Date.parse(record.at) : NaN;
  if (!record || Number.isNaN(at)) return 'never run';
  if (record.version !== running) return `last run with stim ${record.version}`;
  const age = now.getTime() - at;
  if (age > DOCTOR_STALE_MS) return `last run ${Math.floor(age / DAY_MS)} days ago`;
  return null;
}

export function updateCacheFile(): string {
  return join(getConfigDir(), 'update-check.json');
}

interface UpdateCache {
  checkedAt: string;
  latest: string | null;
}

function readUpdateCache(): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(updateCacheFile(), 'utf-8'));
    if (typeof parsed?.checkedAt !== 'string') return null;
    return { checkedAt: parsed.checkedAt, latest: typeof parsed.latest === 'string' ? parsed.latest : null };
  } catch {
    return null;
  }
}

function writeUpdateCache(cache: UpdateCache): void {
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    writeFileSync(updateCacheFile(), `${JSON.stringify(cache)}\n`);
  } catch {
    // A read-only state directory only costs a retry on the next guide call.
  }
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  const res = await fetchImpl(LATEST_URL, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
  if (!res.ok) return null;
  const body = (await res.json()) as { version?: unknown };
  return typeof body.version === 'string' ? body.version : null;
}

export async function checkForUpdate(
  running: string,
  { now = new Date(), fetch: fetchImpl = fetch }: { now?: Date; fetch?: typeof fetch } = {},
): Promise<string | null> {
  if (process.env.STIM_NO_UPDATE_CHECK) return null;
  const cached = readUpdateCache();
  const checkedAt = cached ? Date.parse(cached.checkedAt) : NaN;
  let latest = cached?.latest ?? null;
  if (Number.isNaN(checkedAt) || now.getTime() - checkedAt > UPDATE_CHECK_INTERVAL_MS) {
    try {
      latest = await fetchLatest(fetchImpl);
    } catch {
      latest = null;
    }
    writeUpdateCache({ checkedAt: now.toISOString(), latest });
  }
  if (!latest) return null;
  const comparison = compareStimVersions(latest, running);
  return comparison !== null && comparison > 0 ? latest : null;
}

export interface DoctorDue {
  platform: DoctorPlatform;
  reason: string;
}

export interface GuideStatusFacts {
  running: string;
  doctor: DoctorDue[];
  latest: string | null;
}

export function renderGuideStatus({ running, doctor, latest }: GuideStatusFacts): string | null {
  const lines: string[] = [];
  if (doctor.length) {
    const named = doctor.map((due) => `${due.platform} (${due.reason})`).join(' and ');
    const flag = doctor.length === 1 ? doctor[0]?.platform : '<ios|android>';
    lines.push(`  Doctor is due for ${named}.`, `  Run before native work:  stim doctor --platform ${flag}`);
  }
  if (latest) lines.push(`  stim ${latest} is available (running ${running}):  npm install -g stim@latest`);
  if (!lines.length) return null;
  return ['STATUS', ...lines].join('\n');
}

export async function guideStatus({
  projectRoot,
  running,
  now = new Date(),
  fetch: fetchImpl = fetch,
}: {
  projectRoot: string | null;
  running: string;
  now?: Date;
  fetch?: typeof fetch;
}): Promise<string | null> {
  const doctor: DoctorDue[] = [];
  if (projectRoot) {
    const runs = getProject(projectRoot)?.doctorRuns ?? {};
    for (const platform of PLATFORMS) {
      const reason = doctorDueReason(runs[platform], running, now);
      if (reason) doctor.push({ platform, reason });
    }
  }
  const latest = await checkForUpdate(running, { now, fetch: fetchImpl });
  return renderGuideStatus({ running, doctor, latest });
}
