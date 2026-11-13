import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEngineRunOp } from '../api/engine-route.ts';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stim-engine-route-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const engine = (name: string, exports: string) => {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'api.mjs'), `export async function runOp(name) { return name; }\n${exports}`);
  return dir;
};

test('routes to an engine that speaks this run-op integer, or predates it, and refuses one that speaks another', async () => {
  const current = await loadEngineRunOp(engine('current', 'export const RUN_OP_VERSION = 1;'));
  expect(await current?.('identity', [], {})).toBe('identity');
  const older = await loadEngineRunOp(engine('older', ''));
  expect(await older?.('identity', [], {})).toBe('identity');
  const newer = await loadEngineRunOp(engine('newer', 'export const RUN_OP_VERSION = 2;'));
  await expect(newer?.('identity', [], {})).rejects.toMatchObject({
    code: 'STIM_ENGINE_UNAVAILABLE',
    remedy: expect.stringContaining('stim engine update'),
  });
});
