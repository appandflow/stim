import { CliUsageError, defineOp, runCli } from '../cli/define-op.ts';

const ran: string[] = [];
const gc = defineOp({
  name: 'gc',
  description: 'a gc with the 2.0 flags',
  options: {
    dryRun: { flags: '--dry-run', description: 'report' },
    pressure: { flags: '--pressure <level>', description: 'level' },
  },
  run: () => {
    ran.push('gc');
  },
});
const other = defineOp({
  name: 'other',
  description: 'a command that never had those flags',
  options: {},
  run: () => {},
});

async function refusal(op: typeof gc, args: string[]): Promise<string> {
  try {
    await runCli(op, args, { version: '9.9.9' });
  } catch (error) {
    if (error instanceof CliUsageError) return error.message;
    throw error;
  }
  return 'ran';
}

test.each([
  [['--delete'], '--delete', '--dry-run'],
  [['--older-than', '3d'], '--older-than', 'maintenance.olderThanDays'],
  [['--cache', 'parked'], '--cache', 'gc --dry-run --pressure critical'],
  [['--worktrees'], '--worktrees', 'stim worktree remove'],
  [['--cache=all'], '--cache', 'gc --dry-run --pressure critical'],
])('stim gc %j is refused with the replacement and runs no pass', async (args, flag, replacement) => {
  const message = await refusal(gc, args);

  expect(message).toContain(`'${flag}' was removed`);
  expect(message).toContain(replacement);
  expect(ran).toEqual([]);
});

test('an unknown flag that was never removed, or a removed name on another command, keeps the generic error', async () => {
  expect(await refusal(gc, ['--bogus'])).toBe("error: unknown option '--bogus'");
  expect(await refusal(other, ['--delete'])).toBe("error: unknown option '--delete'");
});
