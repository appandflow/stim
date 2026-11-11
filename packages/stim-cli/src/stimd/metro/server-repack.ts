import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { processGroupAlive } from '@stim-cli/core/ownership-claim';
import { getExecutor } from '../../exec.ts';
import { signalProcessTree } from '../../metro.ts';
import { type NdjsonRecord, type NdjsonWriter, createNdjsonWriter } from '../../ndjson.ts';
import { type BundlerConfig, detectBundlerConfig, resolvePackageJson } from '../../workspace/project-files.ts';
import { type ChildOutput, type ChildServerHandle, superviseChildServer } from './child-server.ts';
import { supervisorError } from './errors.ts';
import { projectNodeLine, withProjectNode } from './project-node.ts';
import { expoBinFromPackage, recordFromLine, repositoryRoot } from './server-expo.ts';
import { MODE_REPACK } from './state.ts';

export async function startRepackServer({
  root,
  port,
  logsDir,
  writer = null,
  spawnFn = null,
  killTimeoutMs = 5000,
  resetCache = false,
  platform = process.platform,
  output = null,
  extraEnv = {},
  baseEnv = process.env,
}: {
  root: string;
  port: number;
  logsDir: string;
  writer?: NdjsonWriter | null;
  spawnFn?: ((cmd: string, args: string[], opts: SpawnOptions) => ChildProcess) | null;
  killTimeoutMs?: number;
  resetCache?: boolean;
  platform?: NodeJS.Platform;
  /** File stdio and its own process group, for a child that outlives its parent, instead of pipes. */
  output?: { files: ChildOutput; fds: [number, number] } | null;
  extraEnv?: Record<string, string>;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<ChildServerHandle> {
  const config = detectBundlerConfig(root);
  const bin = config?.bundler === 'repack' ? repackBin(root, config.cli) : null;
  if (!bin) {
    const refusal = repackBinRefusal(root, config);
    throw supervisorError('STIM_REPACK_BIN', refusal.message, refusal.remedy);
  }
  const log = writer || createNdjsonWriter(join(logsDir, 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  const spawn = spawnFn || ((cmd: string, args: string[], opts: SpawnOptions) => getExecutor().spawn(cmd, args, opts));
  const args = [
    'start',
    '--port',
    String(port),
    '--no-interactive',
    '--no-reverse-port',
    '--json',
    ...(resetCache ? ['--reset-cache'] : []),
  ];
  // Windows shims run the package bin through another node, so Stim runs it with its own (see startExpoServer).
  const [command, commandArgs] = platform === 'win32' ? [process.execPath, [bin, ...args]] : [bin, args];
  const node = withProjectNode(root, baseEnv, { top: repositoryRoot(root) ?? root });
  if (node.pinned) {
    log.write({
      src: 'metro',
      level: 'info',
      event: 'project_node',
      msg: `Re.Pack runs on ${projectNodeLine(node.pinned)}`,
    });
  }
  const group = output !== null && platform !== 'win32';
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: output ? ['ignore', ...output.fds] : ['ignore', 'pipe', 'pipe'],
    detached: group,
    // Re.Pack 5 runs `$ANDROID_HOME/platform-tools/adb reverse` on every connected device before each Android
    // compile, even with --no-reverse-port, and ignores its failures; Stim reverses only the devices it drives.
    env: { ...node.env, FORCE_COLOR: '0', ANDROID_HOME: devNull, ...extraEnv },
  });
  return superviseChildServer({
    mode: MODE_REPACK,
    child,
    log,
    toRecord: repackRecords(),
    signal: (sig) => {
      if (!group || !child.pid) return child.kill(sig);
      try {
        return signalProcessTree(child.pid, sig, { group, platform });
      } catch {
        return false;
      }
    },
    alive: group ? () => child.pid !== undefined && processGroupAlive(child.pid) : null,
    killTimeoutMs,
    output: output?.files,
  });
}

/** Why the Re.Pack dev server a project's config names cannot start, or null when it can or none is named. */
export function repackServerProblem(root: string): { message: string; remedy: string } | null {
  const config = detectBundlerConfig(root);
  if (config?.bundler !== 'repack' || repackBin(root, config.cli)) return null;
  return repackBinRefusal(root, config);
}

function repackBin(root: string, cli: BundlerConfig['cli']): string | null {
  if (!resolvePackageJson(root, '@callstack/repack')) return null;
  return expoBinFromPackage(resolvePackageJson(root, cli), cli);
}

function repackBinRefusal(root: string, config: BundlerConfig | null): { message: string; remedy: string } {
  const cli = config?.cli ?? 'rock';
  return {
    message:
      `Cannot start the Re.Pack dev server ${config ? `${config.config} names ` : ''}for ${root}: ` +
      `\`${cli}\` or \`@callstack/repack\` is not resolvable from it.`,
    remedy:
      "Install the project's dependencies (in a monorepo, from the workspace root), or set metro.command to the command that starts this project's dev server.",
  };
}

/**
 * Turns Re.Pack's `--json` log lines into records. Re.Pack compiles a platform only once a device asks for its
 * bundle, so its progress events become `bundle_build_started` and `bundle_build_done` records for that platform.
 * Other lines, such as Rock's own output, stay raw `repack_stdout` and `repack_stderr` records.
 */
export function repackRecords(): (chunk: unknown, stream: 'stdout' | 'stderr') => NdjsonRecord | null {
  const building = new Set<string>();
  return (chunk, stream) => {
    const entry = parseRepackEntry(chunk);
    if (!entry) return recordFromLine(chunk, { stream, source: 'repack' });
    const progress = entry.progress;
    if (progress) {
      if (typeof progress.time === 'number') {
        building.delete(progress.platform);
        return {
          src: 'metro',
          level: 'info',
          event: 'bundle_build_done',
          platform: progress.platform,
          msg: `Re.Pack compiled ${progress.platform} in ${(progress.time / 1000).toFixed(1)}s`,
        };
      }
      if (building.has(progress.platform)) return null;
      building.add(progress.platform);
      return {
        src: 'metro',
        level: 'info',
        event: 'bundle_build_started',
        platform: progress.platform,
        msg: `Re.Pack compiling ${progress.platform}`,
      };
    }
    if (!entry.text) return null;
    return {
      src: 'metro',
      level: entry.level,
      event: `repack_${stream}`,
      msg: entry.issuer ? `[${entry.issuer}] ${entry.text}` : entry.text,
    };
  };
}

interface RepackEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  issuer: string | null;
  text: string;
  progress: { platform: string; time: number | null } | null;
}

/** Re.Pack's `--json` reporter writes each log entry as `{ timestamp, type, issuer, message: [...] }` on one line. */
function parseRepackEntry(chunk: unknown): RepackEntry | null {
  const line = String(chunk ?? '').trim();
  if (!line.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string' || !Array.isArray(value.message)) return null;
  const { type, issuer, message } = value;
  const progress = isRecord(message[0]) && isRecord(message[0].progress) ? message[0].progress : null;
  const platform = progress?.platform;
  return {
    level: type === 'warn' || type === 'error' || type === 'debug' ? type : 'info',
    issuer: typeof issuer === 'string' ? issuer : null,
    text: message.map(messageText).filter(Boolean).join(' '),
    progress:
      type === 'progress' && typeof platform === 'string'
        ? { platform, time: typeof progress?.time === 'number' ? progress.time : null }
        : null,
  };
}

function messageText(part: unknown): string {
  if (typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean') return String(part);
  const msg = isRecord(part) ? part.msg : null;
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.filter((m) => typeof m === 'string').join(' ');
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
