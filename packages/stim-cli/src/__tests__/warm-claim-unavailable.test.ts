import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerWarm } from '../commands/worktree.ts';
import { warmClaimPath } from '../engine/warm-claim.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';

const identity = vi.hoisted(() => ({
  available: false,
  reason: 'ENOSYS (no unique-pid prebuild for this platform)',
}));
const REASON = identity.reason;

vi.mock('../process-identity.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../process-identity.ts')>();
  return {
    ...real,
    captureProcessIdentity: (pid: number) =>
      identity.available ? real.captureProcessIdentity(pid) : { ok: false, reason: identity.reason },
  };
});

let base: string;
let root: string;
let target: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function write(dir: string, rel: string, value: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), value);
}

async function runWarm(cwd: string, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)));
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    const command = new Command();
    registerWarm(command);
    await command.parseAsync(['warm', ...args], { from: 'user' });
    return { stdout, stderr: stderr.join('\n'), code: process.exitCode || 0 };
  } finally {
    process.chdir(previous);
    log.mockRestore();
    error.mockRestore();
  }
}

beforeEach(() => {
  base = execFileSync('/bin/sh', ['-c', 'pwd -P'], {
    cwd: mkdtempSync(join(tmpdir(), 'stim-test-claimless-')),
    encoding: 'utf-8',
  }).trim();
  process.env.STIM_HOME = join(base, 'home');
  const origin = join(base, 'origin.git');
  root = join(base, 'main');
  target = join(base, 'linked');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  execFileSync('git', ['clone', '-q', origin, root], { encoding: 'utf-8' });
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, '.gitignore', '.env*\n.worktrees/\n');
  write(root, 'package.json', '{"name":"claimless-fixture"}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'worktree', 'add', '-qb', 'linked', target);
  write(root, '.env', 'main env');
});

afterEach(() => {
  identity.available = false;
  vi.restoreAllMocks();
  process.exitCode = 0;
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

test.each([[], ['--refresh']])('warm %j refuses before copying when identity cannot be recorded', async (...args) => {
  const head = git(root, 'rev-parse', 'HEAD');
  const result = await runWarm(target, ...args);
  expect(result.code).toBe(1);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toContain('failed: STIM_CLAIM_UNAVAILABLE');
  expect(result.stderr).toContain(REASON);
  expect(result.stderr).toContain('Reinstall Stim');
  expect(result.stderr).not.toMatch(/checkout|carry/);
  expect(existsSync(join(target, '.env'))).toBe(false);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
});

function plant(owner: () => { pid: number; processToken: string }, claimId: string): string {
  identity.available = true;
  try {
    return plantClaim(warmClaimPath(root), 'exclusive', owner(), { claimId });
  } finally {
    identity.available = false;
  }
}

test.each([liveClaimOwner, goneClaimOwner])(
  'identity-unavailable warm refuses regardless of existing holder liveness',
  async (owner) => {
    const claim = plant(owner, 'existing-refresh');
    const result = await runWarm(target);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed: STIM_CLAIM_UNAVAILABLE');
    expect(existsSync(join(target, '.env'))).toBe(false);
    expect(existsSync(claim)).toBe(true);
  },
);
