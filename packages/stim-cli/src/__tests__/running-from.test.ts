import { othersAmong, runningFromReason, type RunningProcesses } from '../workspace/running-from.ts';

const resolved = vi.hoisted((): { paths: string[] } => ({ paths: [] }));
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return {
    ...fs,
    realpathSync: (...args: Parameters<typeof fs.realpathSync>) => {
      resolved.paths.push(String(args[0]));
      return fs.realpathSync(...args);
    },
  };
});

const SELF = 300;
const listed = (...pids: number[]): RunningProcesses => ({
  commands: pids.map((pid) => ({ pid, line: `/app/bin ${pid}` })),
  cwds: pids.map((pid) => ({ pid, path: '/app' })),
});
const pids = (running: RunningProcesses | null) => running?.cwds.map(({ pid }) => pid);

const TABLE = [
  '    1     0',
  '  100     1',
  '  200   100',
  '  250   200',
  '  300   200',
  '  400   300',
  '  500     1',
].join('\n');

test('the process itself, its ancestors and its descendants do not count; a sibling or another process does', () => {
  const others = othersAmong(listed(100, 200, 250, 300, 400, 500), TABLE, SELF);

  expect(pids(others)).toEqual([250, 500]);
  expect(others?.commands.map(({ pid }) => pid)).toEqual([250, 500]);
});

test('a listed process that is no longer in the later process table has exited and does not count', () => {
  expect(pids(othersAmong(listed(500, 600), TABLE, SELF))).toEqual([500]);
});

test.each([
  ['an empty table', ''],
  ['a table with only a header', '  PID  PPID'],
  ['a table that does not list this process', '  500     1'],
])('%s proves nothing, so nothing is dropped and the caller keeps the folder', (_, table) => {
  expect(othersAmong(listed(500), table, SELF)).toBeNull();
});

test.each([
  { line: 'node /repo/main/node_modules/.bin/metro start', named: true },
  { line: 'tool --root=/repo/main', named: true },
  { line: 'tool /repo/main --flag', named: true },
  { line: 'tool /repo/main-other/file', named: false },
  { line: 'tool /other/repo/main', named: false },
])('a command line $line names the checkout root: $named', ({ line, named }) => {
  const running: RunningProcesses = { commands: [{ pid: 1, line }], cwds: [] };
  const reason = runningFromReason('/repo/main', running);
  expect(reason === 'process 1 runs from it').toBe(named);
});

test('one listing resolves each working directory once, however many folders are asked about', () => {
  const cwds = ['/repo/a/src', '/repo/b/ios'];
  const running: RunningProcesses = { commands: [], cwds: cwds.map((path, at) => ({ pid: at + 1, path })) };
  resolved.paths = [];

  const reasons = ['/repo/a', '/repo/b', '/repo/c'].map((folder) => runningFromReason(folder, running));

  expect(reasons).toEqual(['process 1 works in it', 'process 2 works in it', null]);
  expect(resolved.paths.filter((path) => cwds.includes(path)).toSorted()).toEqual(cwds);
});
