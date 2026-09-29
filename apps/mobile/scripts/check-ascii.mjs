#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const files = globSync('{src,bin,test}/**/*.{ts,tsx,js,mjs}', { cwd: root });

let failed = false;
for (const file of files) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // eslint-disable-next-line no-control-regex -- non-ASCII detection needs the full byte range
    const match = /[^\x00-\x7F]/.exec(lines[i]);
    if (match) {
      console.error(`${file}:${i + 1}: non-ASCII character ${JSON.stringify(match[0])}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\nsrc/, bin/, and test/ must stay ASCII-only; escape as \\uXXXX instead.');
  process.exit(1);
}
