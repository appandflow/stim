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
import { join } from 'node:path';
import { withDirLock, withDirLockAsync, withDirLockTransaction } from '../index.ts';
import { readClaimSet } from '../ownership-claim.ts';

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
    const [owner] = readClaimSet(`${lock}.claims`).live;
    expect(owner).toBeDefined();
    expect(existsSync(lock)).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(owner!.path, old, old);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, CORE_URL, lock], {
      env: process.env,
      encoding: 'utf8',
      timeout: 5000,
    });

    expect(JSON.parse(output)).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
    expect(readClaimSet(`${lock}.claims`).live).toEqual([owner]);
  });

  expect(withDirLock(lock, () => 'released')).toBe('released');
});

test('an existing directory does not participate in locking and is left untouched', () => {
  mkdirSync(lock);
  writeFileSync(join(lock, 'old-owner-token'), 'keep');
  const entries = readdirSync(lock);
  withDirLock(lock, () => {
    expect(contender()).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
    expect(readdirSync(lock)).toEqual(entries);
  });
  expect(readdirSync(lock)).toEqual(entries);
  expect(readFileSync(join(lock, 'old-owner-token'), 'utf8')).toBe('keep');
  expect(withDirLock(lock, () => 'released', { waitMs: 0 })).toBe('released');
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

test('nested calls retain the outer claim when the inner body throws', () => {
  withDirLock(lock, () => {
    expect(() =>
      withDirLock(lock, () => {
        throw new Error('inner');
      }),
    ).toThrow('inner');
    expect(contender()).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
  });
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
  expect(readClaimSet(`${lock}.claims`).dead).toHaveLength(1);
  expect(withDirLock(lock, () => 'recovered', { waitMs: 0 })).toBe('recovered');
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
  } finally {
    for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
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

function holdInChild(holdMs: number) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { withDirLock } = await import(process.argv[1]);
    withDirLock(process.argv[2], () => {
      process.stdout.write('held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[3]));
    });
  `,
      CORE_URL,
      lock,
      String(holdMs),
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const { stdout } = child;
  if (!stdout) throw new Error('the holder has no stdout');
  return { held: once(stdout, 'data'), exited: once(child, 'exit'), child };
}

test.each(['resolve', 'reject'])('an asynchronous transaction holds its claim until the body %ss', async (outcome) => {
  let enter = () => {};
  let finish = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = new Error('transaction failed');
  const held = withDirLockTransaction(lock, async () => {
    enter();
    await release;
    if (outcome === 'reject') throw failure;
    return 'finished';
  });
  const completion = held.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await entered;
    await expect(withDirLockTransaction(lock, () => 'overlapped', { waitMs: 0 })).rejects.toMatchObject({
      code: 'STIM_LOCK_TIMEOUT',
    });
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, CORE_URL, lock], {
      env: process.env,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(JSON.parse(output)).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
  } finally {
    finish();
    await completion;
  }
  expect(await completion).toEqual(outcome === 'reject' ? { error: failure } : { value: 'finished' });
  expect(await withDirLockTransaction(lock, () => 'released', { waitMs: 0 })).toBe('released');
});

test('an async acquisition waits for another process without blocking the event loop', async () => {
  const holder = holdInChild(600);
  try {
    await holder.held;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    let ticksWhenEntered = -1;
    try {
      await withDirLockAsync(lock, () => {
        ticksWhenEntered = ticks;
      });
    } finally {
      clearInterval(timer);
    }
    expect(ticksWhenEntered).toBeGreaterThan(5);
  } finally {
    holder.child.kill('SIGKILL');
    await holder.exited;
  }
});

test('an async acquisition that times out reports the same lock error as the sync wait', async () => {
  const holder = holdInChild(5000);
  try {
    await holder.held;
    const entered = vi.fn<() => void>();
    await expect(withDirLockAsync(lock, entered, { waitMs: 100, pollMs: 10 })).rejects.toMatchObject({
      code: 'STIM_LOCK_TIMEOUT',
      lockPath: lock,
      message: expect.stringContaining('Another Stim process is holding it'),
    });
    expect(entered).not.toHaveBeenCalled();
  } finally {
    holder.child.kill('SIGKILL');
    await holder.exited;
  }
});

test('an async acquisition inside a held lock runs its body before the outer body returns', () => {
  const order: string[] = [];
  withDirLock(lock, () => {
    void withDirLockAsync(lock, () => order.push('inner'));
    order.push('outer');
  });
  expect(order).toEqual(['inner', 'outer']);
});

test('cancelling a waiting async acquisition keeps the holder and skips the transaction', async () => {
  const holder = holdInChild(5000);
  const controller = new AbortController();
  const entered = vi.fn<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await holder.held;
    timer = setTimeout(() => controller.abort(), 50);
    await expect(withDirLockAsync(lock, entered, { signal: controller.signal, waitMs: 1800 })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(entered).not.toHaveBeenCalled();
    expect(contender()).toEqual({ code: 'STIM_LOCK_TIMEOUT', lockPath: lock });
  } finally {
    clearTimeout(timer);
    holder.child.kill('SIGKILL');
    await holder.exited;
  }
});

test('a waiting async acquisition does not keep the claim that a sync call in the same process needs', async () => {
  let release = () => {};
  const held = withDirLockTransaction(
    lock,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const waiting = withDirLockAsync(lock, () => 'entered', { waitMs: 2000, pollMs: 10 });
  try {
    release();
    await held;
    expect(withDirLock(lock, () => 'sync', { waitMs: 0 })).toBe('sync');
    await expect(waiting).resolves.toBe('entered');
  } finally {
    release();
    await held;
    await waiting;
  }
});
