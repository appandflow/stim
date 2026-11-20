import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

interface HelperLine {
  generation: number;
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
  replace(generation: number, watch: object): void;
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
  const replace = (generation: number, next: object) =>
    child.stdin.write(`${JSON.stringify({ generation, watch: [next] })}\n`);
  replace(1, watch);
  return {
    seen,
    replace,
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

  function fixture(): { dev: number; parent: string; roots: [string, string, string] } {
    const parent = mkdtempSync(join(scratch, 'roots-'));
    const roots: [string, string, string] = [join(parent, 'a'), join(parent, 'b'), join(parent, 'c')];
    for (const dir of roots) mkdirSync(dir);
    return { dev: statSync(parent).dev, parent, roots };
  }

  async function storedState(dev: number, roots: string[]): Promise<{ uuid: string; eventId: number }> {
    const helper = startHelper({ dev, roots });
    const first = await helper.next((line) => line.purged !== undefined);
    expect(first).toMatchObject({ generation: 1, dev, purged: 'no-since', uuid: expect.any(String) });
    await helper.next((line) => line.historyDone === true);
    await helper.closeInput();
    if (typeof first.uuid !== 'string') throw new Error('the helper reported no FSEvents uuid');
    return { uuid: first.uuid, eventId: first.eventId };
  }

  function dirtyRoots(seen: HelperLine[], rootsByGeneration: Record<number, string[]>): Set<string> {
    return new Set(
      seen.flatMap((line) => (line.dirty ?? []).map((index) => rootsByGeneration[line.generation]?.[index] ?? '')),
    );
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

  test('tags every line with the generation whose root indexes it uses across a watch replacement', async () => {
    const { dev, roots } = fixture();
    const first = [roots[0], roots[1]];
    const second = [roots[1], roots[0]];
    const helper = startHelper({ dev, roots: first });
    const done = await helper.next((line) => line.historyDone === true);
    writeFileSync(join(roots[0], 'file'), 'x');
    helper.replace(2, { dev, uuid: done.uuid, since: done.eventId, roots: second });
    await helper.next((line) => line.generation === 2 && line.historyDone === true);
    await helper.next(() => dirtyRoots(helper.seen, { 1: first, 2: second }).has(roots[0]));
    expect(dirtyRoots(helper.seen, { 1: first, 2: second })).toEqual(new Set([roots[0]]));
    expect(await helper.closeInput()).toBe(0);
  }, 30_000);

  test('reports the roots under a renamed parent without moving the event id', async () => {
    const { dev, parent, roots } = fixture();
    const outside = mkdtempSync(join(scratch, 'outside-'));
    const watched = [...roots, outside];
    const helper = startHelper({ dev, roots: watched });
    const done = await helper.next((line) => line.historyDone === true);
    renameSync(parent, `${parent}-moved`);
    await helper.next(() => roots.every((root) => dirtyRoots(helper.seen, { 1: watched }).has(root)));
    expect(dirtyRoots(helper.seen, { 1: watched }).has(outside)).toBe(false);
    for (const line of helper.seen.filter((seen) => seen.dirty)) expect(line.eventId).toBe(done.eventId);
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

  test.each([
    ['a line without a generation', '{"watch":[]}'],
    ['an invalid JSON number', '{"generation":1,"watch":[],"other":1e}'],
    ['a number with a leading zero', '{"generation":1,"watch":[],"other":01}'],
    ['a NUL byte inside a number', '{"generation":1,"watch":[],"other":1\u00002}'],
    ['a relative root', '{"generation":1,"watch":[{"dev":1,"roots":["relative"]}]}'],
    [
      'more roots than one stream accepts',
      JSON.stringify({ generation: 1, watch: [{ dev: 1, roots: Array.from({ length: 1025 }, (_, i) => `/r${i}`) }] }),
    ],
    ['a line over 4 MiB', 'x'.repeat(5 * 1024 * 1024)],
  ])('refuses %s with exit status 65 and no output', (_name, input) => {
    const result = spawnSync(binary, ['0.1'], { input: `${input}\n`, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(65);
    expect(result.stdout).toBe('');
  });
});
