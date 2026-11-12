import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { type NdjsonWriter, createNdjsonWriter } from '../../ndjson.ts';
import { METRO_COMMAND_PORT } from '../../workspace/settings.ts';
import type { ServerLaunch } from './child-server.ts';
import { repositoryRoot } from './server-expo.ts';
import { projectNodeLine, withProjectNode } from './project-node.ts';

function commandArgv(command: readonly string[], port: number): string[] {
  return command.map((arg) => arg.replaceAll(METRO_COMMAND_PORT, String(port)));
}

/** The `metro.command` argv with `{port}` replaced, run from the app directory with the project's Node. */
export function commandServerLaunch({
  root,
  port,
  logsDir,
  command,
  writer = null,
  extraEnv = {},
  baseEnv = process.env,
}: {
  root: string;
  port: number;
  logsDir: string;
  command: readonly string[];
  extraEnv?: Record<string, string>;
  baseEnv?: NodeJS.ProcessEnv;
  writer?: NdjsonWriter | null;
}): ServerLaunch {
  const log = writer || createNdjsonWriter(join(logsDir, 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  const [program, ...args] = commandArgv(command, port);
  log.write({
    src: 'metro',
    level: 'debug',
    event: 'cache_store_skipped',
    msg: 'metro.command starts the dev server, so Stim does not add its shared Metro transform store',
  });
  const node = withProjectNode(root, baseEnv, { top: repositoryRoot(root) ?? root });
  if (node.pinned) {
    log.write({
      src: 'metro',
      level: 'info',
      event: 'project_node',
      msg: `Metro runs on ${projectNodeLine(node.pinned)}`,
    });
  }
  return {
    command: program as string,
    args,
    env: { ...node.env, FORCE_COLOR: '0', ...extraEnv },
    observesRequests: false,
  };
}
