import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfigDir, getProject, upsertProject, withConfigLockAsync } from './workspace/config.ts';
import { projectRegistry } from './integrations/projects.ts';
import type { DoctorPlatform } from './diagnostics/doctor.ts';
import { compareStimVersions } from './diagnostics/stim-installations.ts';
import { legacyDaemonHolder } from './daemon/legacy-daemon.ts';
import { readSettingsContext, unknownEntries } from './workspace/settings-payload.ts';
import {
  isJsonObject,
  parseUnit,
  RETIRED_SETTING_KEYS,
  UPGRADE_GUIDE_URL,
  type DoctorRunRecord,
  type ProjectRecord,
} from '@stim-cli/core/state';

const DAY_MS = 24 * 60 * 60 * 1000;
const DOCTOR_STALE_MS = 7 * DAY_MS;
const UPDATE_CHECK_INTERVAL_MS = DAY_MS;
const UPDATE_CHECK_TIMEOUT_MS = 2000;
const LATEST_URL = 'https://registry.npmjs.org/stim/latest';

/** Records CLI history best-effort; storage failures do not fail the CLI report. */
export function recordDoctorRun(
  projectRoot: string,
  platform: DoctorPlatform | undefined,
  version: string,
  now: Date = new Date(),
  platforms?: readonly DoctorPlatform[],
): void {
  const run: DoctorRunRecord = { at: now.toISOString(), version };
  try {
    const targets = platforms ?? projectRegistry.selectDoctor(projectRoot, platform).platforms;
    if (targets.length === 0) return;
    writeDoctorRun(projectRoot, targets, run);
  } catch {}
}

/** Records a completed check, rejecting unavailable state and honoring cancellation while waiting for its lock. */
export async function recordDoctorCheck(
  projectRoot: string,
  platform: DoctorPlatform | undefined,
  version: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const targets = projectRegistry.selectDoctor(projectRoot, platform).platforms;
  if (targets.length === 0) return;
  await withConfigLockAsync(() => {
    writeDoctorRun(projectRoot, targets, { at: new Date().toISOString(), version });
  }, signal);
}

function writeDoctorRun(projectRoot: string, targets: readonly DoctorPlatform[], run: DoctorRunRecord): void {
  upsertProject(projectRoot, (existing) => {
    const doctorRuns = { ...existing.doctorRuns };
    for (const target of targets) doctorRuns[target] = run;
    return { doctorRuns };
  });
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
  const target = updateCacheFile();
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
    renameSync(tmp, target);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  const res = await fetchImpl(LATEST_URL, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return isJsonObject(body) && typeof body.version === 'string' ? body.version : null;
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

interface DoctorDue {
  platform: DoctorPlatform;
  reason: string;
}

interface GuideStatusFacts {
  running: string;
  leftovers: string[];
  doctor: DoctorDue[];
  latest: string | null;
}

const majorOf = (version: string | undefined): number | null => {
  const found = /^(\d+)\./.exec(version ?? '');
  return found ? Number(found[1]) : null;
};

const listed = (names: string[]): string =>
  names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');

/** The environment variables a 1.x Stim read that 2.0 refuses or ignores; the migration guide names each one's remedy. */
const RETIRED_EXPORTS = [
  'STIM_MAINTENANCE',
  'STIM_MAINTENANCE_DEVICE_IDLE_DAYS',
  'STIM_BUDGET_MIN_FREE_DISK_GB',
  'STIM_BUDGET_HARD_FLOOR_DISK_GB',
  'STIM_MAINTENANCE_CRITICAL_FREE_DISK_GB',
  'STIM_REMOTE_BUILD_MODE',
  'STIM_WEBRTC_STUN',
  'STIM_BUDGET_MAX_COMMITTED_MEMORY_GB',
  'STIM_BUDGET_MAX_LIVE_WORKSPACES',
  'STIM_MAINTENANCE_CAP_TARGET_PERCENT',
  'STIM_MAINTENANCE_IDLE_CHECK_MINUTES',
  'STIM_MAINTENANCE_MAX_LOAD_PER_CORE',
  'STIM_MAINTENANCE_MEMORY_PRESSURE_LEVEL',
  'STIM_MAINTENANCE_MEMORY_WARNING_MINUTES',
  'STIM_MAINTENANCE_MIN_AVAILABLE_MEMORY_GB',
  'STIM_MAINTENANCE_PRESSURE_CHECK_MINUTES',
  'STIM_MAINTENANCE_PRESSURE_PROTECT_MINUTES',
  'STIM_MAINTENANCE_SIZE_CHECK_MINUTES',
  'STIM_MAINTENANCE_URGENT_FREE_DISK_GB',
];

const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:\+[\w.-]*)?$/;
const at = (major: number, minor = 0, patch = 0): number => major * 1e6 + minor * 1e3 + patch;

/**
 * The versions an npm comparator admits, as [from, to): `^1.40.0` is [1.40.0, 2.0.0); null for one it cannot read,
 * including a prerelease bound, whose npm matching rules this does not model.
 */
function comparatorSpan(comparator: string): [number, number] | null {
  const [, op = '', text = ''] = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(comparator) ?? [];
  const found = PARTIAL.exec(text);
  if (!found) return null;
  const [major, minor, patch] = found.slice(1, 4).map((part) => (part && /^\d+$/.test(part) ? Number(part) : null));
  if (major === null || major === undefined) return [0, Infinity];
  const from = at(major, minor ?? 0, patch ?? 0);
  const to =
    minor === null || minor === undefined
      ? at(major + 1)
      : patch === null || patch === undefined
        ? at(major, minor + 1)
        : from + 1;
  if (op === '>=') return [from, Infinity];
  if (op === '>') return [to, Infinity];
  if (op === '<') return [0, from];
  if (op === '<=') return [0, to];
  if (op === '^') return [from, major > 0 ? at(major + 1) : at(0, (minor ?? 0) + 1)];
  if (op === '~') return [from, minor === null || minor === undefined ? at(major + 1) : at(major, minor + 1)];
  return [from, to];
}

/** Whether npm range `range` admits a version of major `major`; null when Stim cannot read one of its alternatives. */
function admitsMajor(range: string, major: number): boolean | null {
  let unreadable = false;
  for (const set of range.split('||')) {
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(set);
    const spans = hyphen
      ? [comparatorSpan(`>=${hyphen[1]}`), comparatorSpan(`<=${hyphen[2]}`)]
      : set
          .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(comparatorSpan);
    const read = spans.filter((span): span is [number, number] => span !== null);
    if (read.length < spans.length) {
      unreadable = true;
      continue;
    }
    const from = Math.max(at(major), ...read.map(([low]) => low));
    const to = Math.min(at(major + 1), ...read.map(([, high]) => high));
    if (from < to) return true;
  }
  return unreadable ? null : false;
}

function projectPins(projectRoot: string, running: number): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  } catch {
    return [];
  }
  if (!isJsonObject(manifest)) return [];
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = manifest[field];
    if (!isJsonObject(deps)) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || /^(workspace|link|file):/.test(range)) continue;
      if (name === 'stim' && admitsMajor(range, running) === false && admitsMajor(range, running - 1))
        names.add(`stim ${range}`);
      else if (name.startsWith('@stim-cli/') && name !== '@stim-cli/cache-s3') names.add(name);
    }
  }
  return [...names];
}

const SERVER_SCRIPT = /(?:^|\/)stim-server(?:\.mjs)?$/;
const PLIST_SERVER_SCRIPT = /<string>[^<]*\/stim-server(?:\.mjs)?<\/string>/;

function earlierServices(): string[] {
  const launchd = process.platform === 'darwin';
  if (!launchd && process.platform !== 'linux') return [];
  const dir = launchd ? join(homedir(), 'Library', 'LaunchAgents') : join(homedir(), '.config', 'systemd', 'user');
  const extension = launchd ? '.plist' : '.service';
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(extension));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const text = readFileSync(join(dir, name), 'utf-8');
      if (launchd) return PLIST_SERVER_SCRIPT.test(text) ? [name.slice(0, -extension.length)] : [];
      const unit = parseUnit(text);
      return unit && SERVER_SCRIPT.test(unit.script ?? '') ? [unit.label] : [];
    } catch {
      return [];
    }
  });
}

/** What an earlier Stim left that this one does not read or replaced, each as one short phrase. */
async function upgradeLeftovers(
  projectRoot: string | null,
  cwd: string,
  env: NodeJS.ProcessEnv,
  runs: DoctorRunRecord[],
  running: string,
): Promise<string[]> {
  const found: string[] = [];
  try {
    const keys = [
      ...new Set(
        unknownEntries(await readSettingsContext(cwd, env))
          .map((entry) => entry.key)
          .filter((key) => RETIRED_SETTING_KEYS.has(key)),
      ),
    ];
    if (keys.length) found.push(`retired settings (${listed(keys)})`);
  } catch {}
  const variables = RETIRED_EXPORTS.filter((name) => env[name]?.trim());
  if (variables.length) found.push(`retired environment variables (${listed(variables)})`);
  // compat C32 until 2.1.0
  const older = legacyDaemonHolder();
  if (older) found.push(`a daemon from an older Stim (pid ${older.owner.pid})`);
  // compat end
  const services = earlierServices();
  if (services.length) found.push(`a service installed by an earlier Stim (${listed(services)})`);
  const current = majorOf(running);
  if (projectRoot && current !== null) {
    const pins = projectPins(projectRoot, current);
    if (pins.length) found.push(`package.json names ${listed(pins)}`);
  }
  const checked = runs.find((run) => {
    const ran = majorOf(run.version);
    return ran !== null && current !== null && ran < current;
  });
  if (checked) found.push(`doctor last ran with stim ${checked.version}`);
  return found;
}

function renderGuideStatus({ running, leftovers, doctor, latest }: GuideStatusFacts): string | null {
  const lines: string[] = [];
  if (leftovers.length)
    lines.push(
      `  Not migrated from an earlier Stim: ${leftovers.join('; ')}.`,
      `  Before other work, follow:  ${UPGRADE_GUIDE_URL}`,
    );
  if (doctor.length) {
    const named = doctor.map((due) => `${due.platform} (${due.reason})`).join(' and ');
    const command = doctor.length === 1 ? `stim doctor --platform ${doctor[0]?.platform}` : 'stim doctor';
    lines.push(`  Doctor is due for ${named}.`, `  Run before native work:  ${command}`);
  }
  if (latest) lines.push(`  stim ${latest} is available (running ${running}):  npm install -g stim@latest`);
  if (!lines.length) return null;
  return ['STATUS', ...lines].join('\n');
}

export async function guideStatus({
  projectRoot,
  running,
  cwd = projectRoot ?? process.cwd(),
  env = process.env,
  now = new Date(),
  fetch: fetchImpl = fetch,
}: {
  projectRoot: string | null;
  running: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  fetch?: typeof fetch;
}): Promise<string | null> {
  const doctor: DoctorDue[] = [];
  const recorded: DoctorRunRecord[] = [];
  if (projectRoot) {
    const platforms = projectRegistry.selectDoctor(projectRoot).platforms;
    let runs: NonNullable<ProjectRecord['doctorRuns']> | null = null;
    try {
      runs = getProject(projectRoot)?.doctorRuns ?? {};
    } catch {
      // A corrupt config refuses every stateful command with its remedy; the guide still prints.
    }
    if (runs) {
      for (const platform of platforms) {
        const run = runs[platform];
        if (run) recorded.push(run);
        const reason = doctorDueReason(run, running, now);
        if (reason) doctor.push({ platform, reason });
      }
    }
  }
  const leftovers = await upgradeLeftovers(projectRoot, cwd, env, recorded, running);
  const latest = await checkForUpdate(running, { now, fetch: fetchImpl });
  return renderGuideStatus({ running, leftovers, doctor, latest });
}
