import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { forbidden, staticClosure } from './dist-closure.mjs';

const dist = mkdtempSync(join(tmpdir(), 'stim-dist-closure-'));
afterAll(() => rmSync(dist, { recursive: true, force: true }));
const files = {
  'package.json': '{ "name": "stim" }',
  'clean.mjs': '//#region bin/cli.ts\nimport { readFileSync } from "node:fs";\nimport("./lazy.mjs");\n//#endregion\n',
  'lazy.mjs': '//#region src/offload/client.ts\nimport { WebSocket } from "ws";\n//#endregion\n',
  'eager.mjs': '//#region bin/cli.ts\nimport { a } from "./shared.mjs";\n//#endregion\n',
  'shared.mjs': '//#region src/offload/tailnet.ts\nimport { WebSocket } from "ws";\n//#endregion\n',
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(dist, name), text);
const rules = [
  ['ws', /^ws(\/|$)/],
  ['offload/', /^stim\/src\/offload\//],
];

describe('dist closure gate', () => {
  it('passes a closure that reaches forbidden modules only through import()', () => {
    expect(forbidden(staticClosure([join(dist, 'clean.mjs')], new Map()), rules)).toEqual([]);
  });

  it('names each forbidden module a static import chain reaches, with the chain', () => {
    const hits = forbidden(staticClosure([join(dist, 'eager.mjs')], new Map()), rules);
    expect(hits.map(({ rule, module, path }) => [rule, module, path.length])).toEqual([
      ['offload/', 'stim/src/offload/tailnet.ts', 2],
      ['ws', 'ws', 2],
    ]);
  });
});
