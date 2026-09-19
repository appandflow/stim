import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { withDirLock } from '../index.ts';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';

const faults = vi.hoisted(() => ({
  created: null as null | ((path: string) => void),
  creating: null as null | ((path: string) => void),
  listing: null as null | ((path: string) => void),
  renaming: null as null | ((from: string, to: string) => void),
  removing: null as null | ((path: string) => void),
  removed: null as null | ((path: string) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      faults.creating?.(String(args[0]));
      const result = fs.mkdirSync(...args);
      faults.created?.(String(args[0]));
      return result;
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      faults.listing?.(String(args[0]));
      return fs.readdirSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      faults.renaming?.(String(args[0]), String(args[1]));
      return fs.renameSync(...args);
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      faults.removing?.(String(args[0]));
      fs.rmSync(...args);
      faults.removed?.(String(args[0]));
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      fs.unlinkSync(...args);
      faults.removed?.(String(args[0]));
    },
  };
});

const KILLED_EXIT = process.platform === 'win32' ? [1, null] : [null, 'SIGKILL'];

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
  faults.created = null;
  faults.creating = null;
  faults.listing = null;
  faults.renaming = null;
  faults.removing = null;
  faults.removed = null;
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

test.each(['empty', 'legacy'])('an unidentified %s directory needs explicit removal even when it is old', (kind) => {
  mkdirSync(lock);
  if (kind === 'legacy') writeFileSync(join(lock, 'old-owner-token'), '');
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

describe.skipIf(process.platform !== 'win32')('a lock directory removed by hand while a waiter polls', () => {
  const accessDenied = (syscall: string, path: string): never => {
    throw Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${path}'`), { code: 'EPERM', syscall });
  };

  test.each(['mkdir', 'scandir'])(
    'answers %s with access denied once and the waiter takes the lock next',
    (syscall) => {
      mkdirSync(lock);
      const deny = (path: string) => {
        if (path !== lock) return;
        faults.creating = null;
        faults.listing = null;
        rmSync(lock, { recursive: true });
        accessDenied(syscall, path);
      };
      if (syscall === 'mkdir') faults.creating = deny;
      else faults.listing = deny;
      expect(withDirLock(lock, () => 'taken', { pollMs: 1 })).toBe('taken');
      expect(existsSync(lock)).toBe(false);
    },
  );
});

function contender(): unknown {
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, CORE_URL, lock], {
      env: process.env,
      encoding: 'utf8',
      timeout: 5000,
    }),
  );
}

test('a contender cannot enter the empty root before the first owner publishes its claim', () => {
  faults.created = (path) => {
    if (path !== lock) return;
    faults.created = null;
    expect(contender()).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
    expect(readdirSync(lock)).toEqual([]);
  };
  expect(withDirLock(lock, () => 'published')).toBe('published');
  expect(existsSync(lock)).toBe(false);
});

test('a contender cannot enter the empty root between claim removal and directory removal', () => {
  faults.removed = (path) => {
    if (!path.startsWith(join(lock, '.stim-claim-'))) return;
    faults.removed = null;
    expect(contender()).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
  };
  withDirLock(lock, () => {});
  expect(existsSync(lock)).toBe(false);
  expect(withDirLock(lock, () => 'released')).toBe('released');
});

test('a losing publisher does not strand an empty lock after the winning owner releases', () => {
  let winner: ClaimHandle | undefined;
  let losingStaging: string | undefined;
  faults.renaming = (from, to) => {
    if (basename(to) !== 'exclusive') return;
    faults.renaming = null;
    losingStaging = from;
    winner = tryAcquireClaim({ root: dirname(to), mode: 'exclusive' }).acquired;
    expect(winner).toBeDefined();
  };
  faults.removing = (path) => {
    if (path !== losingStaging) return;
    faults.removing = null;
    releaseClaim(winner);
  };

  expect(withDirLock(lock, () => 'acquired', { waitMs: 0 })).toBe('acquired');
  expect(winner).toBeDefined();
  expect(existsSync(lock)).toBe(false);
});

test('nested calls retain the outer claim when the inner body throws', () => {
  withDirLock(lock, () => {
    expect(() =>
      withDirLock(lock, () => {
        throw new Error('inner');
      }),
    ).toThrow('inner');
    expect(contender()).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
  });
  expect(existsSync(lock)).toBe(false);
});

async function killHolder(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { withDirLock } = await import(process.argv[1]);
    withDirLock(process.argv[2], () => {
      process.stdout.write('held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    });
  `,
      CORE_URL,
      lock,
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const done = once(child, 'exit');
  try {
    await once(child.stdout!, 'data');
    child.kill('SIGKILL');
    await done;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('a killed owner with a published identity is recovered without waiting', async () => {
  await killHolder();
  expect(existsSync(lock)).toBe(true);
  expect(withDirLock(lock, () => 'recovered', { waitMs: 0 })).toBe('recovered');
  expect(existsSync(lock)).toBe(false);
});

test.each(['publication', 'removal'])(
  'a killed owner in the marker %s gap keeps an unidentified directory',
  async (gap) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const lock = process.argv[2];
      const mkdir = fs.mkdirSync;
      const unlink = fs.unlinkSync;
      fs.mkdirSync = (path, ...args) => {
        const result = mkdir(path, ...args);
        if (process.argv[3] === 'publication' && String(path) === lock) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      fs.unlinkSync = (path) => {
        unlink(path);
        if (process.argv[3] === 'removal' && String(path).startsWith(join(lock, '.stim-claim-'))) process.kill(process.pid, 'SIGKILL');
      };
      syncBuiltinESMExports();
      const { withDirLock } = await import(process.argv[1]);
      withDirLock(lock, () => {});
    `,
        CORE_URL,
        lock,
        gap,
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(await once(child, 'exit')).toEqual(KILLED_EXIT);
    const body = vi.fn<() => void>();
    expect(() => withDirLock(lock, body, { waitMs: 0 })).toThrow(
      expect.objectContaining({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock }),
    );
    expect(body).not.toHaveBeenCalled();
    expect(readdirSync(lock)).toEqual([]);
  },
);

test('a second interrupted recovery does not strand the original visible marker', async () => {
  await killHolder();
  const original = readdirSync(lock);
  const recovery = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const { tryAcquireClaim } = await import(process.argv[1]);
      const attempt = tryAcquireClaim({ root: process.argv[2], mode: 'exclusive' });
      if (!attempt.acquired || attempt.reaped.length !== 1) throw new Error('did not reap the original owner');
      process.kill(process.pid, 'SIGKILL');
    `,
      new URL('../ownership-claim.ts', import.meta.url).href,
      `${lock}.claims`,
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(await once(recovery, 'exit')).toEqual(KILLED_EXIT);
  expect(readdirSync(lock)).toEqual(original);
  expect(withDirLock(lock, () => 'recovered', { waitMs: 0 })).toBe('recovered');
  expect(existsSync(lock)).toBe(false);
});

test('concurrent dead-owner reapers preserve each replacement owner and serialize updates', async () => {
  await killHolder();
  const counter = join(home, 'counter');
  writeFileSync(counter, '0');
  const workers = Array.from({ length: 4 }, () =>
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    const { withDirLock } = await import(process.argv[1]);
    const { readFileSync, writeFileSync } = await import('node:fs');
    for (let i = 0; i < 10; i++) {
      withDirLock(process.argv[2], () => {
        const value = Number(readFileSync(process.argv[3], 'utf8'));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        writeFileSync(process.argv[3], String(value + 1));
      }, { waitMs: 5000, pollMs: 2 });
    }
  `,
        CORE_URL,
        lock,
        counter,
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  try {
    const exits = await Promise.all(workers.map((child) => once(child, 'exit')));
    expect(exits).toEqual(workers.map(() => [0, null]));
    expect(readFileSync(counter, 'utf8')).toBe('40');
    expect(existsSync(lock)).toBe(false);
  } finally {
    for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test.each([false, true])('release keeps a replacement legacy directory (owner published: %s)', (published) => {
  withDirLock(lock, () => {
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
    if (published) writeFileSync(join(lock, 'replacement-owner'), '');
  });

  expect(readdirSync(lock)).toEqual(published ? ['replacement-owner'] : []);
});

test('a missing parent retains its filesystem error and never enters the body', () => {
  const body = vi.fn<() => void>();
  expect(() => withDirLock(join(home, 'missing', 'entry.lock'), body)).toThrow(
    expect.objectContaining({ code: 'ENOENT' }),
  );
  expect(body).not.toHaveBeenCalled();
});

test('a malformed published record refuses with its claim path and keeps the record', () => {
  const directory = join(`${lock}.claims`, 'exclusive');
  mkdirSync(directory, { recursive: true });
  const claimPath = join(directory, 'broken.claim');
  writeFileSync(claimPath, 'partial');
  const body = vi.fn<() => void>();
  expect(() => withDirLock(lock, body)).toThrow(expect.objectContaining({ code: 'STIM_CLAIM_REFUSED', claimPath }));
  expect(body).not.toHaveBeenCalled();
  expect(readFileSync(claimPath, 'utf8')).toBe('partial');
});

test('a malformed compatibility marker refuses without removing the visible lock', () => {
  mkdirSync(lock);
  const marker = join(lock, '.stim-claim-00000000-0000-0000-0000-000000000000');
  writeFileSync(marker, 'partial');
  const body = vi.fn<() => void>();
  expect(() => withDirLock(lock, body)).toThrow(
    expect.objectContaining({ code: 'STIM_CLAIM_REFUSED', claimPath: lock }),
  );
  expect(body).not.toHaveBeenCalled();
  expect(readFileSync(marker, 'utf8')).toBe('partial');
});
