import { constants } from 'node:os';
import { getExecutor, resetExecutor, runControlPath, runMaintenanceWork } from '../exec.ts';
import { IMPOSSIBLE_PID, makeExitingChild } from './_factories.ts';

const os = vi.hoisted(() => ({ setPriority: vi.fn<(pid: number, priority: number) => void>() }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  setPriority: os.setPriority,
}));
const spawned = vi.hoisted((): { calls: unknown[][] } => ({ calls: [] }));
vi.mock('cross-spawn', async (importOriginal) => {
  const original = await importOriginal<{ default: { sync: unknown } }>();
  const spawn = Object.assign(
    (...args: unknown[]) => {
      spawned.calls.push(args);
      return makeExitingChild();
    },
    { sync: original.default.sync },
  );
  return { default: spawn };
});

const platform = process.platform;
beforeEach(() => {
  resetExecutor();
  os.setPriority.mockClear();
  spawned.calls = [];
  Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
});

const run = () => getExecutor().runFileAsync('tool.exe', ['--flag'], { timeoutMs: 1000 });

test('on Windows a maintenance child starts as it is and is set below normal at normal pressure only', async () => {
  await run();
  await runMaintenanceWork('normal', () => runControlPath(run));
  await runMaintenanceWork('high', run);
  expect(os.setPriority).not.toHaveBeenCalled();
  await runMaintenanceWork('normal', run);
  expect(os.setPriority.mock.calls).toEqual([[IMPOSSIBLE_PID, constants.priority.PRIORITY_BELOW_NORMAL]]);
  expect(spawned.calls.map((call) => [call[0], call[1]])).toEqual(
    Array.from({ length: 4 }, () => ['tool.exe', ['--flag']]),
  );
});
