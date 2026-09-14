import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDirLock } from '../index.ts';

vi.mock('unique-pid', async (importOriginal) => ({
  ...(await importOriginal<typeof import('unique-pid')>()),
  capture: () => ({ ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: 'fixture unavailable' } }),
}));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-core-no-identity-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('unavailable identity neither creates a lock nor runs an unprotected body', () => {
  const lock = join(home, 'test.lock');
  const body = vi.fn<() => void>();
  expect(() => withDirLock(lock, body)).toThrow(expect.objectContaining({ code: 'STIM_CLAIM_UNAVAILABLE' }));
  expect(existsSync(lock)).toBe(false);
  expect(body).not.toHaveBeenCalled();
});

test('unavailable identity preserves an existing occupied lock', () => {
  const lock = join(home, 'test.lock');
  mkdirSync(lock);
  const owner = join(lock, 'legacy-owner');
  writeFileSync(owner, 'keep');
  expect(() => withDirLock(lock, () => {})).toThrow(expect.objectContaining({ code: 'STIM_CLAIM_UNAVAILABLE' }));
  expect(readFileSync(owner, 'utf8')).toBe('keep');
});
