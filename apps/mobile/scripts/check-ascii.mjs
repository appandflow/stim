#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = globSync('{src,bin,test}/**/*', { cwd: root, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));

let failed = false;
for (const path of files) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
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
  console.error('\nsrc/, bin/, and test/ must stay ASCII-only; escape as \\uXXXX instead.');
  process.exit(1);
}
