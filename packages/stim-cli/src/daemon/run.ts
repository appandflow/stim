import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonClaimRoot, daemonSocket, isJsonObject } from '@stim-cli/core/state';
import {
  isClaimRefusal,
  isClaimUnavailable,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { collectOwnedDeviceActivity, workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { triggerMaintenance } from '../maintenance/trigger.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { loadConfig } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { daemonEnabled } from './client.ts';
import { listSims, runIdlePass } from './idle.ts';

const TICK_MS = 60_000;
const CLAIM_TRIES = 30;
const CLAIM_RETRY_MS = 100;
const EMPTY_TICKS_BEFORE_EXIT = 2;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

async function takeClaim(): Promise<ClaimHandle | null> {
  for (let tries = 0; ; tries++) {
    const attempt = tryAcquireClaim({
      root: daemonClaimRoot(),
      mode: 'exclusive',
      label: 'home daemon',
      details: { socket: daemonSocket() },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) return attempt.acquired;
    if (tries >= CLAIM_TRIES) return null;
    await new Promise((done) => setTimeout(done, CLAIM_RETRY_MS));
  }
}

function answers(path: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      done(true);
    });
    probe.once('error', () => done(false));
  });
}

/**
 * Binds the daemon's socket while it holds the daemon claim. Node cannot read a Unix socket peer's uid, so the
 * kernel's check stands in for it: connecting needs write access to a 0600 socket in a 0700 directory this user owns.
 */
async function listen(path: string, server: Server): Promise<void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = lstatSync(dir);
  if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid()))
    throw new Error(`${dir} is not a directory this user owns, so the daemon does not put its socket there.`);
  chmodSync(dir, 0o700);
  if (existsSync(path)) {
    if (await answers(path)) throw new Error(`another process answers on ${path}`);
    rmSync(path, { force: true });
  }
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(path, () => {
      server.off('error', fail);
      done();
    });
  });
  chmodSync(path, 0o600);
}

/**
 * What keeps the daemon running: a dev server, a build, a held build slot or a booted owned device. A device list
 * that cannot be read keeps it running.
 */
function homeAlive(): string | null {
  const config = loadConfig();
  for (const [path, project] of Object.entries(config?.projects ?? {})) {
    const supervisor = resolveSupervisorTarget({
      state: readWorkspaceState(path)?.supervisor,
      record: project.supervisor,
      reservedPort: project.metroPort,
    });
    if (supervisor.status === 'ours' || supervisor.status === 'unverified') return `${path} runs a dev server`;
    if (workspaceBuildInProgress(path)) return `${path} is building`;
  }
  if (listBuildSlots().some((slot) => slot.alive || slot.unresolved)) return 'a build slot is held';
  const ownsDevices = Object.values(config?.projects ?? {}).some((project) =>
    projectDeviceSlots(project).some(({ platforms }) => platforms.ios?.owned || platforms.android?.owned),
  );
  if (!ownsDevices) return null;
  let sims;
  try {
    sims = listSims();
  } catch (error) {
    return `its simulators cannot be listed (${error instanceof Error ? error.message : String(error)})`;
  }
  const booted = collectOwnedDeviceActivity(config, sims, Date.now());
  if (booted.length) return `${booted.length} owned device(s) booted`;
  return null;
}

export async function runDaemon({ tickMs = TICK_MS }: { tickMs?: number } = {}): Promise<void> {
  const started = performance.now();
  const claim = await takeClaim();
  if (!claim) {
    log('another daemon holds the claim; exiting');
    return;
  }
  const path = daemonSocket();
  const waiters = new Set<Socket>();
  let lastContact = Date.now();
  let closing = false;
  const server = createServer((socket) => {
    lastContact = Date.now();
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => waiters.delete(socket));
    socket.on('close', () => waiters.delete(socket));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let op: unknown;
        try {
          const message: unknown = JSON.parse(line);
          op = isJsonObject(message) ? message.op : undefined;
        } catch {
          socket.destroy();
          return;
        }
        if (op === 'hello') socket.end(`${JSON.stringify({ op: 'hello', pid: process.pid })}\n`);
        else if (op === 'slot.wait') {
          waiters.add(socket);
          socket.write(`${JSON.stringify({ op: 'slot.waiting' })}\n`);
        } else if (op === 'slot.released') {
          socket.end();
          for (const waiter of waiters) waiter.write(`${JSON.stringify({ op: 'slot.changed' })}\n`);
        } else socket.destroy();
      }
    });
  });
  let interrupt: (() => void) | null = null;
  let bound = false;
  const onSignal = (signal: NodeJS.Signals) => shutdown(signal);
  const shutdown = (why: string) => {
    if (closing) return;
    closing = true;
    interrupt?.();
    server.close();
    for (const waiter of waiters) waiter.destroy();
    if (bound) rmSync(path, { force: true });
    releaseClaim(claim);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    log(`exiting: ${why}`);
  };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  try {
    await listen(path, server);
    bound = true;
  } catch (error) {
    shutdown(`cannot listen on ${path}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  log(`pid ${process.pid} listening on ${path} after ${Math.round(performance.now() - started)}ms`);
  let emptyTicks = 0;
  for (;;) {
    await new Promise<void>((done) => {
      const timer = setTimeout(done, tickMs);
      interrupt = () => {
        clearTimeout(timer);
        done();
      };
    });
    if (closing) break;
    if (!daemonEnabled()) {
      shutdown('daemon.enabled is off');
      break;
    }
    const tickStarted = performance.now();
    let alive: string | null;
    try {
      await runIdlePass(log);
      triggerMaintenance('daemon', { argv: [], warn: false });
      alive = waiters.size ? 'a build waits for a slot' : homeAlive();
    } catch (error) {
      shutdown(
        `the tick failed, so the supervisors keep their own timers: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
    const idle = !alive && Date.now() - lastContact >= tickMs;
    emptyTicks = idle ? emptyTicks + 1 : 0;
    log(`tick ${Math.round(performance.now() - tickStarted)}ms; ${alive ?? 'nothing alive'}`);
    if (emptyTicks >= EMPTY_TICKS_BEFORE_EXIT) {
      shutdown('nothing alive in this home');
      break;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.title = 'stim-daemon';
  runDaemon().catch((error: unknown) => {
    if (isClaimRefusal(error) || isClaimUnavailable(error)) log(error.message);
    else log(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });
}
