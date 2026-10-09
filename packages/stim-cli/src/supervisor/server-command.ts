import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { signalProcessTree } from '../metro.ts';
import { type NdjsonWriter, createNdjsonWriter } from '../ndjson.ts';
import { METRO_COMMAND_PORT } from '../workspace/settings.ts';
import { type ChildServerHandle, superviseChildServer } from './child-server.ts';
import { recordFromLine } from './server-expo.ts';
import { MODE_COMMAND } from './state.ts';

export function commandArgv(command: readonly string[], port: number): string[] {
  return command.map((arg) => arg.replaceAll(METRO_COMMAND_PORT, String(port)));
}

export async function startCommandServer({
  root,
  port,
  logsDir,
  command,
  writer = null,
  spawnFn = null,
  signalTree = signalProcessTree,
  killTimeoutMs = 5000,
  platform = process.platform,
}: {
  root: string;
  port: number;
  logsDir: string;
  command: readonly string[];
  writer?: NdjsonWriter | null;
  spawnFn?: ((cmd: string, args: string[], opts: SpawnOptions) => ChildProcess) | null;
  signalTree?: typeof signalProcessTree;
  killTimeoutMs?: number;
  platform?: NodeJS.Platform;
}): Promise<ChildServerHandle> {
  const log = writer || createNdjsonWriter(join(logsDir, 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  const spawn = spawnFn || ((cmd: string, args: string[], opts: SpawnOptions) => getExecutor().spawn(cmd, args, opts));
  const [program, ...args] = commandArgv(command, port);
  log.write({
    src: 'metro',
    level: 'debug',
    event: 'cache_store_skipped',
    msg: 'metro.command starts the dev server, so Stim does not add its shared Metro transform store',
  });
  // A wrapper such as yarn runs Metro in a grandchild, so the command gets its own process group to stop as one.
  const group = platform !== 'win32';
  const child = spawn(program as string, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: group,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  return superviseChildServer({
    mode: MODE_COMMAND,
    child,
    log,
    toRecord: (chunk, stream) => recordFromLine(chunk, { stream, source: 'command' }),
    signal: (sig) => {
      if (!child.pid) return false;
      try {
        return signalTree(child.pid, sig, { group, platform });
      } catch {
        return false;
      }
    },
    killTimeoutMs,
  });
}
