import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDirLock } from '../index.ts';

const CORE_URL = new URL('../index.ts', import.meta.url).href;
const CHILD_SCRIPT = `
const { withDirLock } = await import(process.argv[1]);
const lockPath = process.argv[2];
try {
  withDirLock(lockPath, () => process.stdout.write(JSON.stringify({ entered: true })), { waitMs: 100, pollMs: 5 });
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, lockPath: error.lockPath }));
}
`;

let home: string;
let lock: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-core-lock-'));
  lock = join(home, 'test.lock');
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('a competing process cannot take an aged lock while its holder is inside', () => {
  withDirLock(lock, () => {
    const ownerFiles = readdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, CORE_URL, lock], {
      env: process.env,
      encoding: 'utf8',
      timeout: 5000,
    });

    expect(JSON.parse(output)).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
    expect(readdirSync(lock)).toEqual(ownerFiles);
  });

  expect(existsSync(lock)).toBe(false);
  expect(withDirLock(lock, () => 'released')).toBe('released');
});

test('an abandoned directory needs explicit removal even when it is old', () => {
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const body = vi.fn<() => void>();

  expect(() => withDirLock(lock, body, { waitMs: 0 })).toThrow(
    expect.objectContaining({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock }),
  );
  expect(body).not.toHaveBeenCalled();
  expect(existsSync(lock)).toBe(true);

  rmSync(lock, { recursive: true });
  expect(withDirLock(lock, () => 'recovered')).toBe('recovered');
});

test('release keeps a replacement directory and its owner', () => {
  withDirLock(lock, () => {
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
    writeFileSync(join(lock, 'replacement-owner'), '');
  });

  expect(readdirSync(lock)).toEqual(['replacement-owner']);
});
