import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOperation, type ApiOperation } from '../run-operation.ts';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-run-operation-'));
  process.env.STIM_HOME = join(dir, 'home');
  env = { ...process.env, STIM_DAEMON: 'off' };
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const api = (operation: ApiOperation | null, platform?: string, admission: 'command' | 'none' = 'command') =>
  runOperation({ caller: 'api', operation, platform, admission, cwd: dir, env });
const cli = (command: string, plan = false) => runOperation({ caller: 'cli', command, plan, cwd: dir, env });

describe('runOperation', () => {
  it.each<[ApiOperation, string | undefined, string | null]>([
    ['build', 'ios', 'ios'],
    ['run', 'android', 'android'],
    ['build', 'macos', 'macos'],
    ['run', 'web', 'web'],
    ['build', 'tvos', null],
    ['start', undefined, 'start'],
    ['repairDoctor', undefined, 'doctor'],
    ['collectGarbage', undefined, 'gc'],
    ['settings', undefined, null],
    ['stop', undefined, null],
  ])('admits API %s (%s) as the CLI command %s', async (operation, platform, admitted) => {
    await expect(api(operation, platform)).resolves.toEqual({ admitted });
  });

  it('declines admission inside a Stim resident and for a later step of an admitted operation', async () => {
    await expect(api('start', undefined, 'none')).resolves.toEqual({ admitted: null });
    await expect(api(null)).resolves.toEqual({ admitted: null });
  });

  it('admits a top-level CLI command, but not a subcommand or --plan', async () => {
    await expect(cli('ios')).resolves.toEqual({ admitted: 'ios' });
    await expect(cli('')).resolves.toEqual({ admitted: null });
    await expect(cli('ios', true)).resolves.toEqual({ admitted: null });
  });

  it('refuses a governed command while a removed variable is set, for both callers and with --plan', async () => {
    env = { ...env, STIM_MAINTENANCE: 'off' };
    for (const entered of [await cli('start'), await cli('ios', true), await api('build', 'android')])
      expect(entered).toMatchObject({
        refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('STIM_MAINTENANCE') },
      });
    await expect(cli('doctor')).resolves.toEqual({ admitted: 'doctor' });
    await expect(api('build', 'android', 'none')).resolves.toEqual({ admitted: null });
  });
});
