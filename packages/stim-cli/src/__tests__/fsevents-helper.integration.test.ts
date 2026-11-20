import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

interface HelperLine {
  dev: number;
  purged?: string;
  dirty?: number[];
  historyDone?: boolean;
  uuid?: string | null;
  eventId: number;
}

interface Helper {
  next(match: (line: HelperLine) => boolean): Promise<HelperLine>;
  seen: HelperLine[];
  closeInput(): Promise<number | null>;
}

const source = resolve('packages/stim-cli/native/fsevents/stim-fsevents.c');
let scratch = '';
let binary = '';
const children: ChildProcess[] = [];

function startHelper(watch: object): Helper {
  const child = spawn(binary, ['0.1'], { stdio: ['pipe', 'pipe', 'inherit'] });
  children.push(child);
  const seen: HelperLine[] = [];
  const waiters: { match: (line: HelperLine) => boolean; resolve: (line: HelperLine) => void }[] = [];
  createInterface({ input: child.stdout }).on('line', (text) => {
    const line: HelperLine = JSON.parse(text);
    seen.push(line);
    for (const waiter of waiters.splice(0)) {
      if (waiter.match(line)) waiter.resolve(line);
      else waiters.push(waiter);
    }
  });
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  child.stdin.write(`${JSON.stringify({ watch: [watch] })}\n`);
  return {
    seen,
    next: (match) =>
      new Promise((done) => {
        const found = seen.find(match);
        if (found) done(found);
        else waiters.push({ match, resolve: done });
      }),
    closeInput: () => {
      child.stdin.end();
      return exited;
    },
  };
}

describe.skipIf(process.platform !== 'darwin')('stim-fsevents helper', () => {
  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fsevents-')));
    binary = join(scratch, 'stim-fsevents');
    execFileSync(
      'clang',
      [
        '-Wall',
        '-Wextra',
        '-Werror',
        '-O2',
        '-mmacosx-version-min=14.0',
        '-framework',
        'CoreServices',
        '-o',
        binary,
        source,
      ],
      { timeout: 60_000 },
    );
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function fixture(): { dev: number; roots: [string, string, string] } {
    const root = mkdtempSync(join(scratch, 'roots-'));
    const roots: [string, string, string] = [join(root, 'a'), join(root, 'b'), join(root, 'c')];
    for (const dir of roots) mkdirSync(dir);
    return { dev: statSync(root).dev, roots };
  }

  async function storedState(dev: number, roots: string[]): Promise<{ uuid: string; eventId: number }> {
    const helper = startHelper({ dev, roots });
    const first = await helper.next((line) => line.purged !== undefined);
    expect(first).toMatchObject({ dev, purged: 'no-since', uuid: expect.any(String) });
    await helper.next((line) => line.historyDone === true);
    await helper.closeInput();
    if (typeof first.uuid !== 'string') throw new Error('the helper reported no FSEvents uuid');
    return { uuid: first.uuid, eventId: first.eventId };
  }

  test('replays the roots changed since a stored id, then streams live changes until stdin closes', async () => {
    const { dev, roots } = fixture();
    const stored = await storedState(dev, roots);
    const observer = startHelper({ dev, roots });
    await observer.next((line) => line.historyDone === true);
    mkdirSync(join(roots[1], 'nested'));
    writeFileSync(join(roots[1], 'nested', 'file'), 'x');
    writeFileSync(join(roots[2], 'file'), 'x');
    await observer.next(() => observer.seen.flatMap((line) => line.dirty ?? []).includes(1));
    await observer.next(() => observer.seen.flatMap((line) => line.dirty ?? []).includes(2));
    await observer.closeInput();

    const helper = startHelper({ dev, uuid: stored.uuid, since: stored.eventId, roots });
    const done = await helper.next((line) => line.historyDone === true);
    const replayed = new Set(helper.seen.flatMap((line) => line.dirty ?? []));
    expect(replayed).toEqual(new Set([1, 2]));
    expect(helper.seen.some((line) => line.purged)).toBe(false);
    expect(done.eventId).toBeGreaterThan(stored.eventId);

    writeFileSync(join(roots[0], 'live'), 'x');
    const live = await helper.next((line) => line.dirty?.includes(0) === true);
    expect(live.eventId).toBeGreaterThanOrEqual(done.eventId);
    expect(await helper.closeInput()).toBe(0);
  }, 30_000);

  test.each([
    ['a uuid from another FSEvents database', { uuid: '00000000-0000-0000-0000-000000000000' }, 'uuid-changed'],
    ['an event id ahead of the current one', { since: Number.MAX_SAFE_INTEGER }, 'id-ahead'],
  ])(
    'reports purged history for %s',
    async (_name, override, reason) => {
      const { dev, roots } = fixture();
      const stored = await storedState(dev, roots);
      const helper = startHelper({ dev, uuid: stored.uuid, since: stored.eventId, roots, ...override });
      const purged = await helper.next((line) => line.purged !== undefined);
      expect(purged).toMatchObject({ dev, purged: reason, uuid: stored.uuid });
      expect(purged.eventId).toBeGreaterThanOrEqual(stored.eventId);
      await helper.next((line) => line.historyDone === true);
      expect(await helper.closeInput()).toBe(0);
    },
    30_000,
  );
});
