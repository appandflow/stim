import { realpathSync } from 'node:fs';
import { ensureConfig, getConfigDir, getProject, loadConfig, saveConfig, withConfigLock } from './workspace/config.ts';
import { getExecutor } from './exec.ts';
import { withWorkspaceProcessLock } from './engine/workspace-process-lock.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from './process-identity.ts';
import { isPortFree } from './ports.ts';

const FIRST_PORT = 8900;
const LAST_PORT = 8999;

function validatePortLabel(label: string): void {
  if (label === 'metro') throw new Error('metro is managed by stim start and stim stop; choose another label.');
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(label)) {
    throw new Error(
      'A port label must start with a letter and contain at most 64 letters, digits, underscores or hyphens.',
    );
  }
}

export function portListeners(port: number): number[] {
  let out: string;
  try {
    out = getExecutor().runFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 5000 });
  } catch (error) {
    const result = error as { status?: number; stdout?: unknown; stderr?: unknown };
    if (result.status === 1 && !String(result.stdout ?? '').trim() && !String(result.stderr ?? '').trim()) return [];
    throw new Error(`Could not inspect TCP port ${port} with lsof: ${(error as Error).message}`, { cause: error });
  }
  const pids = out.trim() ? out.trim().split(/\s+/).map(Number) : [];
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error(`lsof returned an invalid listener for TCP port ${port}.`);
  }
  return [...new Set(pids)];
}

function withPortsLock<T>(fn: () => Promise<T>): Promise<T> {
  return withWorkspaceProcessLock(getConfigDir(), 'ports', fn, { external: true });
}

export async function getNamedPort(
  projectPath: string,
  label: string,
  {
    isFree = async (port: number) => (await isPortFree(port)) && portListeners(port).length === 0,
    log = console.error,
  }: { isFree?: (port: number) => Promise<boolean>; log?: (line: string) => void } = {},
): Promise<number> {
  validatePortLabel(label);
  const root = realpathSync(projectPath);
  return withPortsLock(async () => {
    const existing = getProject(root)?.ports;
    if (existing && Object.hasOwn(existing, label)) return existing[label]!;
    for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
      const projects = Object.values(loadConfig()?.projects ?? {});
      if (projects.some((project) => project.metroPort === port || Object.values(project.ports ?? {}).includes(port)))
        continue;
      if (!(await isFree(port))) {
        log(`Port ${port} already in use, trying next...`);
        continue;
      }
      const claimed = withConfigLock(() => {
        const cfg = ensureConfig();
        if (
          Object.values(cfg.projects).some(
            (project) => project.metroPort === port || Object.values(project.ports ?? {}).includes(port),
          )
        )
          return false;
        const project = (cfg.projects[root] ??= { metroPort: null, platforms: {} });
        project.ports = { ...project.ports, [label]: port };
        saveConfig(cfg);
        return true;
      });
      if (claimed) return port;
    }
    throw new Error(
      `No free named port between ${FIRST_PORT} and ${LAST_PORT}. Use stim ports stop or stim ports release in a workspace that no longer needs its ports.`,
    );
  });
}

async function stopListeners(port: number, label: string, dryRun: boolean, log: (line: string) => void): Promise<void> {
  for (const pid of portListeners(port)) {
    if (pid === process.pid) throw new Error(`Refusing to stop Stim itself on ${label} (${port}).`);
    const identity = captureProcessIdentity(pid);
    if (!identity.ok) {
      if (!portListeners(port).includes(pid)) continue;
      throw new Error(`Cannot identify pid ${pid} on ${label} (${port}): ${identity.reason}`);
    }
    const record = { pid, processToken: identity.token };
    const command = getExecutor()
      .runFile('ps', ['-p', String(pid), '-o', 'args='], { timeoutMs: 5000 })
      .trim();
    if (dryRun) {
      log(`would stop ${label} (${port}): pid ${pid} ${command}`);
      continue;
    }
    if (!portListeners(port).includes(pid)) continue;
    const status = inspectProcessIdentity(record);
    if (status === 'gone' || status === 'different') continue;
    if (status !== 'same') throw new Error(`Cannot verify pid ${pid} on ${label} (${port}); allocation kept.`);
    try {
      process.kill(pid, 'SIGTERM');
      if (!(await waitForProcessExit(record, 2000))) {
        if (inspectProcessIdentity(record) !== 'same') throw new Error(`Cannot verify pid ${pid} before SIGKILL.`);
        process.kill(pid, 'SIGKILL');
        if (!(await waitForProcessExit(record, 2000))) throw new Error(`Pid ${pid} did not exit.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    log(`stopped ${label} (${port}): pid ${pid} ${command}`);
  }
  if (!dryRun && portListeners(port).length) throw new Error(`Port ${port} still has a listener; allocation kept.`);
}

export async function clearNamedPorts(
  projectPath: string,
  {
    label,
    stop = false,
    dryRun = false,
    log = console.error,
  }: { label?: string; stop?: boolean; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<void> {
  if (label !== undefined) validatePortLabel(label);
  await withPortsLock(async () => {
    const ports = getProject(projectPath)?.ports ?? {};
    const failures: string[] = [];
    for (const [name, port] of Object.entries(ports)) {
      if (label !== undefined && name !== label) continue;
      try {
        if (!Number.isInteger(port) || port < FIRST_PORT || port > LAST_PORT) {
          throw new Error(`Invalid named port ${name} (${port}); repair its config record before cleanup.`);
        }
        if (stop) {
          if (Object.values(loadConfig()?.projects ?? {}).some((project) => project.metroPort === port)) {
            throw new Error(`Port ${port} is reserved for managed Metro; allocation kept.`);
          }
          await stopListeners(port, name, dryRun, log);
        }
        if (dryRun) {
          log(`would release ${name} (${port})`);
          continue;
        }
        withConfigLock(() => {
          const cfg = loadConfig();
          const current = cfg?.projects?.[projectPath]?.ports;
          if (!cfg || current?.[name] !== port) return;
          delete current[name];
          saveConfig(cfg);
        });
        log(`released ${name} (${port})`);
      } catch (error) {
        failures.push(`${name} (${port}): ${(error as Error).message}`);
      }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  });
}
