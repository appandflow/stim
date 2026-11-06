#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { processContext } from '../src/cli-operation.ts';
import { engineRoot } from '../src/engine-store/store.ts';
import { promote } from '../src/engine-store/promote.ts';
import { installKind } from './route.mjs';

const { values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    source: { type: 'string' },
    'set-by': { type: 'string', default: 'engine-select' },
    pin: { type: 'string' },
    channel: { type: 'string' },
    explicit: { type: 'boolean', default: false },
  },
});
const root = engineRoot(process.env);
const self = values.source ?? dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const { version } = JSON.parse(readFileSync(join(self, 'package.json'), 'utf8'));
try {
  const result = await promote({
    root,
    source: ['npx', 'project'].includes(installKind(self, root)) ? { version } : { dir: self },
    setBy: values['set-by'],
    explicit: values.explicit,
    pinReason: values.pin ?? null,
    channel: values.channel === 'next' || values.channel === 'latest' ? values.channel : undefined,
    ctx: processContext(process.cwd()),
  });
  if ('refused' in result) process.stderr.write(`${result.refused}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 'flipped' in result || 'staged' in result ? 0 : 2;
} catch (error) {
  process.stderr.write(`engine-select: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
