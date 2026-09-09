import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isolatedRunnerInvocation,
  prepareRunnerIsolation,
  runnerIsolationPolicy,
  verifyIsolationCompatibility,
} from './runner-isolation.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stim-runner-isolation-'));
  roots.push(root);
  const golden = join(root, 'golden');
  const results = join(root, 'results');
  const run = join(results, 'current');
  const tools = join(root, 'tools with "quotes"');
  for (const path of [golden, run, tools]) mkdirSync(path, { recursive: true });
  const privateFile = join(root, 'pins.env');
  writeFileSync(privateFile, 'private');
  writeFileSync(join(tools, 'version.txt'), 'fixture-tool');
  const policy = runnerIsolationPolicy({ protectedRoots: [root], readPaths: [tools], writePaths: [run] });
  return { root, golden, results, run, tools, privateFile, policy };
}

function verifiedIsolation(directory, policy) {
  mkdirSync(directory, { recursive: true });
  const profilePath = join(directory, 'runner-isolation.sb');
  writeFileSync(profilePath, policy);
  return {
    backend: 'macos-sandbox-exec',
    verified: true,
    profilePath,
    profileSha256: createHash('sha256').update(policy).digest('hex'),
  };
}

const realExecute = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });

function prepare(paths, policy = paths.policy) {
  return prepareRunnerIsolation({
    policy,
    profilePath: join(paths.root, 'runner-isolation.sb'),
    probeRoots: [paths.root, paths.golden, paths.results],
    probeParent: paths.run,
    execute: realExecute,
  });
}

describe('benchmark runner filesystem isolation', () => {
  it('rejects configured grants inside reserved data, including future paths and aliases, but allows scoped run paths', () => {
    const paths = fixture();
    const worktrees = join(paths.root, 'worktrees');
    mkdirSync(worktrees);
    const alias = join(paths.root, 'golden-alias');
    symlinkSync(paths.golden, alias);
    const options = {
      protectedRoots: [paths.root, worktrees],
      reservedRoots: [paths.golden, paths.results, worktrees],
      readPaths: [paths.tools],
      writePaths: [],
      scopedAccess: { writePaths: [paths.run, join(worktrees, 'current')] },
    };
    expect(() => runnerIsolationPolicy(options)).not.toThrow();
    for (const grant of [
      paths.root,
      paths.golden,
      join(paths.golden, 'android', 'stim-home'),
      join(alias, 'android'),
      join(paths.results, 'pilot', 'previous-run'),
      join(worktrees, 'previous-run'),
    ]) {
      for (const key of ['readPaths', 'writePaths']) {
        expect(() => runnerIsolationPolicy({ ...options, [key]: [grant] })).toThrow(
          'configured grant overlaps a reserved directory',
        );
      }
    }
    expect(() => runnerIsolationPolicy({ ...options, scopedAccess: { writePaths: [paths.results] } })).toThrow(
      'scoped grant covers a reserved directory',
    );
  });
  it.skipIf(process.platform !== 'darwin')(
    'allows Git to create the exact future worktree without exposing siblings',
    () => {
      const paths = fixture();
      const repository = mkdtempSync(join(tmpdir(), 'stim-isolation-git-'));
      roots.push(repository);
      const execute = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' });
      execute(['init']);
      execute([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ]);
      const parent = join(paths.root, 'worktrees');
      mkdirSync(parent);
      const target = join(parent, 'current');
      const policy = runnerIsolationPolicy({
        protectedRoots: [paths.root, parent],
        readPaths: [paths.tools],
        writePaths: [paths.run, target],
      });
      const isolation = prepare(paths, policy);
      const invocation = isolatedRunnerInvocation(isolation, '/usr/bin/git', [
        'worktree',
        'add',
        '--detach',
        target,
        'HEAD',
      ]);
      execFileSync(invocation.command, invocation.args, { cwd: repository, stdio: 'pipe' });
      expect(execute(['-C', target, 'rev-parse', 'HEAD'])).toBe(execute(['rev-parse', 'HEAD']));
      execute(['worktree', 'remove', target]);
    },
  );
  it('rejects relative paths and grants that would expose a protected root, including symlink aliases', () => {
    const paths = fixture();
    const alias = join(paths.root, 'alias');
    symlinkSync(paths.root, alias);
    for (const grant of [paths.root, tmpdir(), alias]) {
      expect(() => runnerIsolationPolicy({ protectedRoots: [paths.root], readPaths: [grant], writePaths: [] })).toThrow(
        'grant covers a protected root',
      );
    }
    expect(() => runnerIsolationPolicy({ protectedRoots: ['relative'], readPaths: [], writePaths: [] })).toThrow(
      'must be absolute',
    );
    expect(() => runnerIsolationPolicy({ protectedRoots: [], readPaths: [], writePaths: [] })).toThrow('bounded');
  });

  it.skipIf(process.platform !== 'darwin')(
    'denies coordinator and sibling contents through native and child reads while allowing run/tool access',
    () => {
      const paths = fixture();
      const isolation = prepare(paths);
      expect(isolation.verified).toBe(true);
      const invocation = isolatedRunnerInvocation(isolation, process.execPath, [
        '-e',
        `const fs=require('node:fs');
       const [tool, secret, run] = process.argv.slice(1);
       if(fs.readFileSync(tool,'utf8')!=='fixture-tool')throw Error('tool unreadable');
       try{fs.writeFileSync(tool,'changed');throw Error('tool writable');}catch(e){if(e.code!=='EPERM')throw e;}
       try{fs.readFileSync(secret);throw Error('secret readable');}catch(e){if(e.code!=='EPERM')throw e;}
       fs.writeFileSync(run,'output');
       process.stdout.write('ok');`,
        join(paths.tools, 'version.txt'),
        paths.privateFile,
        join(paths.run, 'proof.txt'),
      ]);
      expect(execFileSync(invocation.command, invocation.args, { encoding: 'utf8' })).toBe('ok');
      expect(readFileSync(paths.privateFile, 'utf8')).toBe('private');
      expect(readFileSync(join(paths.run, 'proof.txt'), 'utf8')).toBe('output');
      writeFileSync(isolation.profilePath, '(version 1) (allow default)');
      expect(() => isolatedRunnerInvocation(isolation, '/bin/true', [])).toThrow('changed after verification');
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'refuses dispatch when a grant exposes golden or sibling result data',
    () => {
      const paths = fixture();
      for (const grant of [paths.golden, paths.results]) {
        const policy = runnerIsolationPolicy({
          protectedRoots: [paths.root],
          readPaths: [paths.tools, grant],
          writePaths: [paths.run],
        });
        expect(() => prepare(paths, policy)).toThrow('protected benchmark access was allowed');
      }
    },
  );

  it('refuses iOS timing when the exact policy blocks nested sandboxes or ps identity and no adapter compensates', () => {
    const paths = fixture();
    const isolation = verifiedIsolation(paths.root, paths.policy);
    const refusals = {
      nested: 'sandbox-exec: sandbox_apply: Operation not permitted',
      ps: '/bin/sh: /bin/ps: Operation not permitted',
    };
    const calls = [];
    const execute = (denied) => (file, args) => {
      calls.push([file, args]);
      const command = args.slice(2).join(' ');
      const key = command.includes('/usr/bin/true') ? 'nested' : command.includes('/bin/ps') ? 'ps' : 'unknown';
      if (!denied.includes(key)) return '';
      throw Object.assign(new Error('Command failed'), { status: 71, stderr: `${refusals[key]}\n` });
    };
    expect(() =>
      verifyIsolationCompatibility(isolation, {
        platform: 'ios',
        nativeCompatibility: null,
        execute: execute(['nested', 'ps']),
      }),
    ).toThrow('sandbox-exec: sandbox_apply: Operation not permitted');
    expect(calls.length).toBeGreaterThan(0);
    for (const [file, args] of calls) {
      expect(file).toBe('/usr/bin/sandbox-exec');
      expect(args.slice(0, 2)).toEqual(['-p', paths.policy]);
    }
    expect(() =>
      verifyIsolationCompatibility(isolation, { platform: 'ios', nativeCompatibility: null, execute: execute(['ps']) }),
    ).toThrow('/bin/sh: /bin/ps: Operation not permitted');
    const compensated = {
      nestedSandbox: { permitted: false, error: refusals.nested },
      processIdentity: { permitted: false, error: refusals.ps },
    };
    expect(
      verifyIsolationCompatibility(isolation, {
        platform: 'ios',
        nativeCompatibility: { manifestSha256: 'pinned' },
        execute: execute(['nested', 'ps']),
      }),
    ).toEqual(compensated);
    expect(
      verifyIsolationCompatibility(isolation, {
        platform: 'android',
        nativeCompatibility: null,
        execute: execute(['nested', 'ps']),
      }),
    ).toEqual(compensated);
    expect(
      verifyIsolationCompatibility(isolation, { platform: 'ios', nativeCompatibility: null, execute: execute([]) }),
    ).toEqual({ nestedSandbox: { permitted: true }, processIdentity: { permitted: true } });
  });

  it.skipIf(process.platform !== 'darwin')(
    'detects the real nested-sandbox and ps refusals under the exact policy but not under a deny-free one',
    () => {
      const paths = fixture();
      const isolation = prepare(paths);
      expect(() =>
        verifyIsolationCompatibility(isolation, { platform: 'ios', nativeCompatibility: null, execute: realExecute }),
      ).toThrow('sandbox-exec: sandbox_apply: Operation not permitted');
      const record = verifyIsolationCompatibility(isolation, {
        platform: 'android',
        nativeCompatibility: null,
        execute: realExecute,
      });
      expect(record.nestedSandbox).toEqual({
        permitted: false,
        error: 'sandbox-exec: sandbox_apply: Operation not permitted',
      });
      expect(record.processIdentity.permitted).toBe(false);
      expect(record.processIdentity.error).toContain('/bin/ps: Operation not permitted');
      const open = verifiedIsolation(join(paths.root, 'open'), '(version 1)\n(allow default)\n');
      expect(
        verifyIsolationCompatibility(open, { platform: 'android', nativeCompatibility: null, execute: realExecute })
          .nestedSandbox,
      ).toEqual({ permitted: true });
    },
  );
});
