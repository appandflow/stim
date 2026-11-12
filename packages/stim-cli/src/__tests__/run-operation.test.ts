import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOperation, type ApiOperation } from '../run-operation.ts';

let dir: string;
let env: NodeJS.ProcessEnv;
let restoreAdmission: () => void;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stim-run-operation-'));
  process.env.STIM_HOME = join(dir, 'home');
  env = { ...process.env, STIM_DAEMON: 'off' };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '*' } }));
  const client = await import('../daemon/client.ts');
  const admission = vi.spyOn(client, 'beforeCommand').mockResolvedValue();
  restoreAdmission = () => admission.mockRestore();
});

afterEach(() => {
  restoreAdmission();
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
    ['repairDoctor', undefined, null],
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

  it('admits a resident native run with device logs, without recording workspace use', async () => {
    const client = await import('../daemon/client.ts');
    await expect(api('run', 'ios', 'none')).resolves.toEqual({ admitted: null });
    expect(client.beforeCommand).toHaveBeenCalledWith(
      'ios',
      env,
      expect.objectContaining({
        recordUse: false,
        pin: true,
        deviceLogs: true,
        held: expect.any(Array),
      }),
    );
  });

  it('admits a top-level CLI command, but not a subcommand or --plan', async () => {
    await expect(cli('ios')).resolves.toMatchObject({ admitted: 'ios', end: expect.any(Function) });
    await expect(cli('')).resolves.toMatchObject({ admitted: null, end: expect.any(Function) });
    await expect(cli('ios', true)).resolves.toMatchObject({ admitted: null, end: expect.any(Function) });
  });

  it.each(['ios', 'android'])(
    'starts no daemon and records nothing for `stim %s` outside a project',
    async (command) => {
      const client = await import('../daemon/client.ts');
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      rmSync(join(dir, 'package.json'));
      const entered = await runOperation({ caller: 'cli', command, plan: false, cwd: outside, env });
      expect(entered).toMatchObject({ admitted: null, end: expect.any(Function) });
      expect(client.beforeCommand).not.toHaveBeenCalled();
      expect(existsSync(join(dir, 'home'))).toBe(false);
    },
  );

  it('refuses an oversized environment before admitting either caller', async () => {
    env.LARGE = 'x'.repeat(512 * 1024);
    for (const entered of [await cli('ios'), await api('start')])
      expect(entered).toMatchObject({
        refusal: { code: 'STIM_ENV_TOO_LARGE', message: expect.stringContaining('LARGE') },
      });
  });

  it('refuses a governed command while a removed variable is set, for both callers and with --plan', async () => {
    env = { ...env, STIM_MAINTENANCE: 'off' };
    for (const entered of [await cli('start'), await cli('ios', true), await api('build', 'android')])
      expect(entered).toMatchObject({
        refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('STIM_MAINTENANCE') },
      });
    await expect(cli('doctor')).resolves.toMatchObject({ admitted: 'doctor', end: expect.any(Function) });
    await expect(api('build', 'android', 'none')).resolves.toEqual({ admitted: null });
  });
});

it('collects an attached host created after CLI admission', async () => {
  const client = await import('../daemon/client.ts');
  const end = vi.fn<() => void>();
  const lookup = vi.spyOn(client, 'attachedHostEnd').mockReturnValue(async () => end());
  try {
    const entered = await cli('stop');
    expect(lookup).not.toHaveBeenCalled();
    if ('refusal' in entered) throw new Error('unexpected refusal');
    await entered.end?.();
    expect(end).toHaveBeenCalledOnce();
  } finally {
    lookup.mockRestore();
  }
});

it.each(['STIM_DAEMON_UNAVAILABLE', 'STIM_ENGINE_UNAVAILABLE', 'STIM_CLAIM_UNAVAILABLE', 'STIM_CLAIM_REFUSED'])(
  'refuses CLI admission for %s',
  async (code) => {
    const client = await import('../daemon/client.ts');
    const failure = vi.spyOn(client, 'beforeCommand').mockRejectedValueOnce(
      Object.assign(new Error('engine unavailable'), {
        code,
        remedy: 'repair the engine',
      }),
    );
    try {
      await expect(cli('ios')).resolves.toMatchObject({
        refusal: { code, remedy: 'repair the engine' },
      });
    } finally {
      failure.mockRestore();
    }
  },
);

it('preserves an admission refusal if its attached host already failed during cleanup', async () => {
  const client = await import('../daemon/client.ts');
  const before = vi
    .spyOn(client, 'beforeCommand')
    .mockRejectedValueOnce(
      Object.assign(new Error('daemon unavailable'), { code: 'STIM_DAEMON_UNAVAILABLE', remedy: 'retry' }),
    );
  const end = vi.spyOn(client, 'attachedHostEnd').mockReturnValue(async () => {
    throw new Error('host exited');
  });
  try {
    await expect(cli('ios')).resolves.toMatchObject({
      refusal: { code: 'STIM_DAEMON_UNAVAILABLE', message: 'daemon unavailable', remedy: 'retry' },
    });
    expect(end).toHaveBeenCalledOnce();
  } finally {
    before.mockRestore();
    end.mockRestore();
  }
});

it('keeps an attached host when an unrelated admission error is best effort', async () => {
  const client = await import('../daemon/client.ts');
  const before = vi.spyOn(client, 'beforeCommand').mockRejectedValueOnce(new Error('unrelated'));
  const end = vi.spyOn(client, 'attachedHostEnd');
  try {
    await expect(cli('ios')).resolves.toMatchObject({ admitted: 'ios' });
    expect(end).not.toHaveBeenCalled();
  } finally {
    before.mockRestore();
    end.mockRestore();
  }
});

it.each(['on', 'off'])('refuses a creating command on an unresolved home under daemon mode %s', async (mode) => {
  restoreAdmission();
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const workspace = await import('../daemon/command-workspace.ts');
  const recorded = vi.spyOn(workspace, 'commandWorkspace');
  const script = `
    import { tryAcquireClaim, markClaimChildPending } from '@stim-cli/core/ownership-claim';
    import { stimdClaimRoot } from '@stim-cli/core/state';
    const claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive' }).acquired;
    if (!claim) throw new Error('fixture claim unavailable');
    markClaimChildPending(claim);
  `;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: resolve('packages/stim-cli'),
      env,
      stdio: 'ignore',
    });
    expect(await new Promise<number | null>((done) => child.once('close', done))).toBe(0);
    const result = await runOperation({
      caller: 'cli',
      command: 'start',
      plan: false,
      cwd: dir,
      env: { ...env, STIM_DAEMON: mode },
    });
    expect(result).toMatchObject({
      refusal: { code: 'STIM_CLAIM_UNAVAILABLE', remedy: expect.stringContaining('rm ') },
    });
    expect(recorded).not.toHaveBeenCalled();
    expect(await cli('stop')).toHaveProperty('admitted', 'stop');
  } finally {
    recorded.mockRestore();
  }
});
