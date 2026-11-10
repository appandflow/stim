import { othersAmong, type RunningProcesses } from '../workspace/running-from.ts';

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
