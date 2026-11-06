#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { register } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOK = `let tree;
export function initialize(data) { tree = data.tree; }
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (resolved.url.startsWith('file:') && !resolved.url.startsWith(tree)) throw new Error(resolved.url + ' is outside ' + tree);
  return resolved;
}`;

const dist = dirname(realpathSync(fileURLToPath(import.meta.url)));
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, {
  data: { tree: `${pathToFileURL(dirname(dist)).href}/` },
});
Reflect.set(globalThis, Symbol.for('stim.main'), true);
const { main } = await import(pathToFileURL(`${dist}/cli.mjs`).href);
await main([process.argv[0], 'stim', 'engine', 'status', '--json']);
