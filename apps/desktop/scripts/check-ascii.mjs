#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = globSync('Sources/**/*.swift', { cwd: root, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));

let failed = false;
for (const path of files) {
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char.codePointAt(0) > 0x7f) {
        console.error(`${relative(root, path)}:${i + 1}: non-ASCII character ${JSON.stringify(char)}`);
        failed = true;
        break;
      }
    }
  }
}

if (failed) {
  console.error('\nSources/ must stay ASCII-only; escape as \\u{XXXX} instead.');
  process.exit(1);
}
