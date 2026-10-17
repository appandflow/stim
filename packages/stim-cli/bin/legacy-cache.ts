import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPlugin, resolveRemote, uploadRemote } from '../src/engine/remote-cache.ts';
import type { LegacyCacheRequest } from '../src/engine/legacy-cache-worker.ts';

const request: LegacyCacheRequest & { messagesPath: string } = JSON.parse(readFileSync(0, 'utf8'));
const journal = openSync(request.messagesPath, 'a', 0o600);
const send = (message: unknown) => {
  writeSync(journal, `${JSON.stringify(message)}\n`);
  return true;
};
const stdout = process.stdout.write.bind(process.stdout);
const stderr = process.stderr.write.bind(process.stderr);
try {
  const provider = {
    plugin: await loadPlugin(request.provider.projectRoot, request.provider.legacyPlugin),
    options: request.provider.options,
  };
  const options = {
    ...request,
    projectRoot: request.provider.projectRoot,
    provider,
    logWriter: { write: (record: unknown) => send({ kind: 'log', record }) },
    note: (line: string) => send({ kind: 'note', line }),
  };
  const value =
    request.phase === 'inspect'
      ? { available: true }
      : request.phase === 'resolve'
        ? await resolveRemote(options)
        : await uploadRemote(options);
  if (value && 'appPath' in value && value.appPath) value.appPath = resolve(value.appPath);
  send({ kind: 'result', value });
} catch (error) {
  send({
    kind: 'result',
    value: {
      failed: String(error instanceof Error ? error.message : error)
        .split('\n')[0]
        ?.slice(0, 200),
    },
  });
}
closeSync(journal);
stdout('', () => stderr('', () => process.exit(0)));
