import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { othersAmong, runningFromReason, type RunningProcesses } from '../workspace/running-from.ts';

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

test.skipIf(process.platform === 'win32')(
  'a command that names a link resolving into the checkout runs from it, and one whose link points elsewhere does not',
  () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-running-from-')));
    onTestFinished(() => rmSync(base, { recursive: true, force: true }));
    const checkout = join(base, 'wt');
    mkdirSync(join(checkout, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(checkout, 'node_modules', '.bin', 'tool'), '');
    mkdirSync(join(base, 'bin'));
    writeFileSync(join(base, 'other'), '');
    symlinkSync(join(checkout, 'node_modules', '.bin', 'tool'), join(base, 'bin', 'tool'));
    symlinkSync(join(base, 'other'), join(base, 'bin', 'other'));
    const run = (line: string) => runningFromReason(checkout, { commands: [{ pid: 7, line }], cwds: [] });

    expect(run(`node ${join(base, 'bin', 'tool')} --watch`)).toMatch(/^process 7 runs .*tool from it$/);
    expect(run(`node ${join(base, 'bin', 'other')}`)).toBeNull();
  },
);
