#!/usr/bin/env node

const parts: number[] = process.versions.node.split('.').map(Number);
const major: number = parts[0] ?? 0;
const minor: number = parts[1] ?? 0;
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`stim-ci requires Node.js 22.12.0 or later; this is ${process.versions.node}.\n`);
  process.exitCode = 1;
} else {
  void import('../src/cli.ts').then(({ main }) => main());
}
