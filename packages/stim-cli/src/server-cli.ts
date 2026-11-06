import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export async function loadServerCli(): Promise<typeof import('../../server/src/cli.ts')> {
  const schema = require.resolve('@stim-cli/server/protocol.schema.json');
  return import(pathToFileURL(join(dirname(schema), 'cli.mjs')).href);
}
