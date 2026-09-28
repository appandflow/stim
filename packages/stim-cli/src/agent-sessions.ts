import { readFileSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { AgentSession, AgentTool } from '@stim-cli/core/state';
import { getExecutor } from './exec.ts';
import { inspectProcessStart } from './process-identity.ts';

const TITLE_MAX_LENGTH = 120;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CODEX_ACTIVE_MS = 30 * 60_000;
const CODEX_QUERY_TIMEOUT_MS = 5000;
/** How long a session that ran a Stim command stays attributed when status cannot see it running. */
const COMMAND_ATTRIBUTION_MS = 30 * 60_000;

/**
 * Claude desktop opens a Claude Code session with `claude://code/continue?session=<id>`, and accepts only its own
 * `local_` session ids there, which a session file carries as `hostSessionId` when the desktop app hosts the session.
 */
const CLAUDE_DESKTOP_SESSION = /^local_[A-Za-z0-9-]{1,64}$/;

/** Which desktop apps that open agent sessions are installed on this Mac. */
export interface AgentApps {
  claude: boolean;
  codex: boolean;
}

function shortTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return undefined;
  return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 3)}...` : title;
}

function isoFromMs(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
}

function withOptional(session: AgentSession, fields: Partial<AgentSession>): AgentSession {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) Object.assign(session, { [key]: value });
  }
  return session;
}

/** The agent session a shell's environment names, from `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`. */
export function agentFromEnv(env: NodeJS.ProcessEnv): { tool: AgentTool; sessionId: string } | null {
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude && SESSION_ID.test(claude)) return { tool: 'claude-code', sessionId: claude };
  const codex = env.CODEX_THREAD_ID?.trim();
  if (codex && SESSION_ID.test(codex)) return { tool: 'codex', sessionId: codex };
  return null;
}

/**
 * A Claude Code session from one `~/.claude/sessions/<pid>.json` file, or null when the entry lacks a pid, session id
 * or absolute cwd. The format is Claude Code's own and undocumented, so every other field is optional.
 */
export function parseClaudeSession(entry: unknown, apps: AgentApps): AgentSession | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const raw = entry as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0) return null;
  if (typeof raw.sessionId !== 'string' || !SESSION_ID.test(raw.sessionId)) return null;
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd)) return null;
  const host = raw.hostSessionId;
  return withOptional(
    { tool: 'claude-code', sessionId: raw.sessionId, cwd: raw.cwd },
    {
      title: shortTitle(raw.name),
      startedAt: isoFromMs(raw.startedAt),
      lastActiveAt: isoFromMs(raw.updatedAt),
      pid: raw.pid as number,
      openUrl:
        apps.claude && typeof host === 'string' && CLAUDE_DESKTOP_SESSION.test(host)
          ? `claude://code/continue?session=${host}`
          : undefined,
    },
  );
}

function isSubagentSource(source: unknown): boolean {
  if (typeof source !== 'string' || !source.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(source);
    return Boolean(parsed && typeof parsed === 'object' && 'subagent' in parsed);
  } catch {
    return false;
  }
}

/**
 * Codex threads from rows of its `threads` table. `name` is the thread's short name; `title` there is the first
 * prompt, so it is never read. Subagent threads, which Codex spawns inside a thread, are left out.
 */
export function parseCodexThreads(rows: unknown, apps: AgentApps): AgentSession[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const raw = row as Record<string, unknown>;
    if (typeof raw.id !== 'string' || !SESSION_ID.test(raw.id)) return [];
    if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || isSubagentSource(raw.source)) return [];
    return [
      withOptional(
        { tool: 'codex', sessionId: raw.id, cwd: raw.cwd },
        {
          title: shortTitle(raw.name),
          startedAt: isoFromMs(raw.created_at_ms),
          lastActiveAt: isoFromMs(raw.updated_at_ms),
          openUrl: apps.codex ? `codex://threads/${raw.id}` : undefined,
        },
      ),
    ];
  });
}

/** The newest `state_<N>.sqlite` in a Codex home listing, or null. */
function codexStateDatabase(names: string[]): string | null {
  let best: { name: string; version: number } | null = null;
  for (const name of names) {
    const version = Number(/^state_(\d+)\.sqlite$/.exec(name)?.[1]);
    if (Number.isFinite(version) && (!best || version > best.version)) best = { name, version };
  }
  return best?.name ?? null;
}

const APP_BUNDLES: Record<keyof AgentApps, { names: string[]; bundleId: string }> = {
  claude: { names: ['Claude'], bundleId: 'com.anthropic.claudefordesktop' },
  codex: { names: ['ChatGPT', 'Codex'], bundleId: 'com.openai.codex' },
};

function bundleInstalled(home: string, { names, bundleId }: { names: string[]; bundleId: string }): boolean {
  for (const folder of ['/Applications', join(home, 'Applications')]) {
    for (const name of names) {
      try {
        if (readFileSync(join(folder, `${name}.app`, 'Contents', 'Info.plist'), 'latin1').includes(bundleId)) {
          return true;
        }
      } catch {}
    }
  }
  return false;
}

/** Whether Claude desktop and the Codex app are installed in /Applications or ~/Applications; macOS only. */
function installedAgentApps(home: string = homedir()): AgentApps {
  if (process.platform !== 'darwin') return { claude: false, codex: false };
  return { claude: bundleInstalled(home, APP_BUNDLES.claude), codex: bundleInstalled(home, APP_BUNDLES.codex) };
}

async function canonical(session: AgentSession): Promise<AgentSession | null> {
  try {
    return { ...session, cwd: await realpath(session.cwd) };
  } catch {
    return null;
  }
}

/**
 * Whether the process `pid` can be the session's: it runs, and it did not start after the session did, which a
 * recycled pid would. A start time that cannot be read counts as running.
 */
function sessionProcessRuns(session: AgentSession): boolean {
  const start = inspectProcessStart(session.pid!);
  if (start.status === 'gone') return false;
  if (start.status === 'unknown' || !session.startedAt) return true;
  return start.startedAtMs <= Date.parse(session.startedAt) + 2000;
}

async function claudeSessions(home: string, apps: AgentApps): Promise<AgentSession[]> {
  const directory = join(home, '.claude', 'sessions');
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions = await Promise.all(
    names.map(async (name) => {
      try {
        const session = parseClaudeSession(JSON.parse(await readFile(join(directory, name), 'utf8')), apps);
        return session && sessionProcessRuns(session) ? await canonical(session) : null;
      } catch {
        return null;
      }
    }),
  );
  return sessions.filter((session): session is AgentSession => session !== null);
}

const CODEX_QUERY = `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare('SELECT id, cwd, name, source, created_at_ms, updated_at_ms FROM threads WHERE archived = 0 AND updated_at_ms >= ? ORDER BY updated_at_ms DESC LIMIT 50').all(Number(process.argv[2]));
db.close();
process.stdout.write(JSON.stringify(rows));`;

async function codexSessions(codexHome: string, apps: AgentApps, now: number): Promise<AgentSession[]> {
  let database: string | null;
  try {
    database = codexStateDatabase(await readdir(codexHome));
  } catch {
    return [];
  }
  if (!database) return [];
  try {
    // node:sqlite needs --experimental-sqlite on Node 22.12, and prints an experimental warning without --no-warnings.
    const out = await getExecutor().runFileAsync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-sqlite',
        '-e',
        CODEX_QUERY,
        join(codexHome, database),
        String(now - CODEX_ACTIVE_MS),
      ],
      { timeoutMs: CODEX_QUERY_TIMEOUT_MS },
    );
    const sessions = await Promise.all(parseCodexThreads(JSON.parse(out), apps).map(canonical));
    return sessions.filter((session): session is AgentSession => session !== null);
  } catch {
    return [];
  }
}

/**
 * The Claude Code sessions whose process runs and the Codex threads updated in the last 30 minutes, with canonical
 * working directories. Every source is optional: a missing, unreadable or changed format yields no sessions from it.
 */
export async function discoverAgentSessions({
  home = homedir(),
  codexHome = process.env.CODEX_HOME || join(home, '.codex'),
  apps = installedAgentApps(home),
  now = Date.now(),
}: { home?: string; codexHome?: string; apps?: AgentApps; now?: number } = {}): Promise<AgentSession[]> {
  const [claude, codex] = await Promise.all([claudeSessions(home, apps), codexSessions(codexHome, apps, now)]);
  return [...claude, ...codex];
}

function within(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** A workspace as attribution sees it: canonical `path`, its git worktree `root`, and the session it recorded. */
export interface AgentWorkspace {
  path: string;
  root: string | null;
  recorded: AgentSession | null;
}

function agentKey(session: AgentSession): string {
  return `${session.tool}:${session.sessionId}`;
}

function activeAt(session: AgentSession): number {
  const at = Date.parse(session.lastActiveAt ?? '');
  return Number.isFinite(at) ? at : -Infinity;
}

/**
 * The sessions working in each workspace, most recently active first. A session belongs to the deepest workspace
 * whose path holds its cwd, and to every workspace whose git worktree root is its cwd. A workspace's recorded session
 * is added with the discovered session's details when it is running, or on its own for `COMMAND_ATTRIBUTION_MS`
 * after the command.
 */
export function attributeAgentSessions(
  workspaces: AgentWorkspace[],
  sessions: AgentSession[],
  now: number,
): AgentSession[][] {
  const found = workspaces.map(() => new Map<string, AgentSession>());
  for (const session of sessions) {
    const holders = workspaces.flatMap((workspace, i) => (within(workspace.path, session.cwd) ? [i] : []));
    const deepest = Math.max(-1, ...holders.map((i) => workspaces[i]!.path.length));
    workspaces.forEach((workspace, i) => {
      const inside = holders.includes(i) && workspace.path.length === deepest;
      if (inside || workspace.root === session.cwd) found[i]!.set(agentKey(session), session);
    });
  }
  workspaces.forEach(({ recorded }, i) => {
    if (!recorded) return;
    const running =
      found[i]!.get(agentKey(recorded)) ?? sessions.find((session) => agentKey(session) === agentKey(recorded));
    if (running) {
      const newer = activeAt(recorded) > activeAt(running);
      found[i]!.set(agentKey(recorded), newer ? { ...running, lastActiveAt: recorded.lastActiveAt } : running);
    } else if (now - activeAt(recorded) <= COMMAND_ATTRIBUTION_MS) {
      found[i]!.set(agentKey(recorded), recorded);
    }
  });
  return found.map((map) => [...map.values()].toSorted((a, b) => activeAt(b) - activeAt(a)));
}
