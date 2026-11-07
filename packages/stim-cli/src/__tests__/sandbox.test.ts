import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect, test } from 'vitest';
import {
  applyClaudeAllowance,
  claudeLocalSettingsPath,
  missingAllowance,
  sandboxAllowance,
  sandboxFinding,
  unmergeableKey,
} from '../diagnostics/sandbox.ts';
import { applySandboxFix } from '../commands/doctor.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'stim-sandbox-'));
}

test('missingAllowance accepts the ways a home path is written, including a parent', () => {
  const dir = scratch();
  const home = '/Users/example';
  const write = (value: unknown): string[] => {
    const path = join(dir, 'settings.local.json');
    writeFileSync(path, JSON.stringify({ sandbox: { filesystem: { allowWrite: [value] } } }));
    return missingAllowance([path], '~/.stim', home);
  };
  try {
    for (const value of ['~/.stim', '~/.stim/', '~/.stim/**', '$HOME/.stim', '/Users/example/.stim', '~']) {
      expect(write(value)).not.toContain('sandbox.filesystem.allowWrite');
    }
    expect(write('~/.stim-other')).toContain('sandbox.filesystem.allowWrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'win32')(
  'missingAllowance accepts a Windows path written with backslashes and a trailing glob (win32 only)',
  () => {
    const dir = scratch();
    const path = join(dir, 'settings.local.json');
    try {
      for (const value of [
        'C:\\Users\\example\\.stim\\*',
        'C:\\Users\\example\\.stim\\**',
        'C:\\Users\\example\\.stim\\',
      ]) {
        writeFileSync(path, JSON.stringify({ sandbox: { filesystem: { allowWrite: [value] } } }));
        expect(missingAllowance([path], '~/.stim', 'C:\\Users\\example')).not.toContain(
          'sandbox.filesystem.allowWrite',
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('missingAllowance asks for the stimd socket until an allowUnixSockets entry covers it', () => {
  const dir = scratch();
  const home = '/Users/example';
  const socket = '/Users/example/.stim/run/stimd.sock';
  const missing = (sockets: string[]): string[] => {
    const path = join(dir, 'settings.local.json');
    writeFileSync(
      path,
      JSON.stringify({
        sandbox: {
          filesystem: { allowWrite: ['~/.stim'] },
          network: {
            allowMachLookup: ['com.apple.coresimulator.*'],
            allowLocalBinding: true,
            allowUnixSockets: sockets,
          },
        },
      }),
    );
    return missingAllowance([path], '~/.stim', home, socket);
  };
  try {
    expect(missing([])).toEqual(['sandbox.network.allowUnixSockets']);
    expect(missing(['/var/run/docker.sock'])).toEqual(['sandbox.network.allowUnixSockets']);
    for (const entry of [socket, '~/.stim/run', '~/.stim/run/stimd.sock']) expect(missing([entry])).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyClaudeAllowance adds the stimd socket to an allowance written without it, keeping other sockets', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    const socket = join(root, 'home', 'run', 'stimd.sock');
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      path,
      JSON.stringify({
        sandbox: {
          filesystem: { allowWrite: ['~/.stim'] },
          network: {
            allowMachLookup: ['com.apple.coresimulator.*'],
            allowLocalBinding: true,
            allowUnixSockets: ['/var/run/docker.sock'],
          },
        },
      }),
    );
    expect(missingAllowance([path], '~/.stim', root, socket)).toEqual(['sandbox.network.allowUnixSockets']);

    expect(applyClaudeAllowance(path, sandboxAllowance('~/.stim', socket)).status).toBe('updated');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      sandbox: { network: { allowUnixSockets: expect.arrayContaining(['/var/run/docker.sock', socket]) } },
    });
    expect(missingAllowance([path], '~/.stim', root, socket)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unmergeableKey names a value the merge would have to discard', () => {
  expect(unmergeableKey({})).toBe(null);
  expect(unmergeableKey({ permissions: { allow: [] } })).toBe(null);
  expect(unmergeableKey({ sandbox: { enabled: true } })).toBe(null);
  expect(unmergeableKey({ sandbox: 'workspace-write' })).toBe('sandbox');
  expect(unmergeableKey({ sandbox: ['a'] })).toBe('sandbox');
  expect(unmergeableKey({ sandbox: { filesystem: 'all' } })).toBe('sandbox.filesystem');
  expect(unmergeableKey({ sandbox: { network: true } })).toBe('sandbox.network');
});

test('applyClaudeAllowance writes the local settings file and leaves it valid JSON', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    expect(path.endsWith(join('.claude', 'settings.local.json'))).toBeTruthy();

    expect(applyClaudeAllowance(path, sandboxAllowance()).status).toBe('created');
    expect(missingAllowance([path])).toEqual([]);

    const before = readFileSync(path, 'utf-8');
    expect(applyClaudeAllowance(path, sandboxAllowance()).status).toBe('updated');
    expect(readFileSync(path, 'utf-8')).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyClaudeAllowance preserves settings it did not come for', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    mkdirSync(join(root, '.claude'));
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash(git *)'] }, sandbox: { enabled: true } }));

    expect(applyClaudeAllowance(path, sandboxAllowance()).status).toBe('updated');
    const after = JSON.parse(readFileSync(path, 'utf-8')) as {
      permissions: { allow: string[] };
      sandbox: { enabled: boolean };
    };
    expect(after.permissions.allow).toEqual(['Bash(git *)']);
    expect(after.sandbox.enabled).toBe(true);
    expect(missingAllowance([path])).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sandboxFinding asks for a restart once the allowance is written but not yet read', () => {
  const dir = scratch();
  try {
    applyClaudeAllowance(claudeLocalSettingsPath(dir), sandboxAllowance());
    const f = sandboxFinding(dir, { env: { CLAUDECODE: '1' }, home: dir, blocked: true });
    expect(f?.fix).toContain('Restart the session');
    expect(f?.title).toContain('has not picked it up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureFix(root: string, env: NodeJS.ProcessEnv): { out: string; exitCode: number | undefined } {
  const lines: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  const realExit = process.exitCode;
  process.exitCode = undefined;
  console.error = (...args: unknown[]): void => void lines.push(args.map(String).join(' '));
  console.log = (...args: unknown[]): void => void lines.push(`STDOUT:${args.map(String).join(' ')}`);
  try {
    const result = applySandboxFix(root, env);
    expect(process.exitCode).toBeUndefined();
    return { out: lines.join('\n'), exitCode: result || undefined };
  } finally {
    console.error = realError;
    console.log = realLog;
    process.exitCode = realExit;
  }
}

test('applySandboxFix writes the allowance, then reports it is already there', () => {
  const root = scratch();
  try {
    const env = { CLAUDECODE: '1', STIM_HOME: join(root, 'home') };
    const first = captureFix(root, env);
    expect(first.out).toContain('Wrote');
    expect(first.exitCode).toBe(undefined);
    expect(missingAllowance([claudeLocalSettingsPath(root)], env.STIM_HOME)).toEqual([]);

    const second = captureFix(root, env);
    expect(second.out).toContain('Nothing to apply');
    expect(second.exitCode).toBe(undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxFix refuses a settings file it cannot read back, and says nothing was written', () => {
  const root = scratch();
  try {
    const path = claudeLocalSettingsPath(root);
    mkdirSync(join(root, '.claude'));
    const contents = '{ // hand written\n "permissions": { "allow": ["Bash(git *)"] } }';
    writeFileSync(path, contents);

    const { out, exitCode } = captureFix(root, { CLAUDECODE: '1', STIM_HOME: join(root, 'home') });
    expect(out).toContain('Nothing was written');
    expect(exitCode).toBe(1);
    expect(readFileSync(path, 'utf-8')).toBe(contents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySandboxFix writes nothing under Codex, and nothing without a harness', () => {
  const root = scratch();
  try {
    const codex = captureFix(root, { CODEX_SANDBOX: 'seatbelt', STIM_HOME: join(root, 'home') });
    expect(codex.out).toContain('Nothing to apply under Codex');
    expect(codex.exitCode).toBe(1);

    const none = captureFix(root, { STIM_HOME: join(root, 'home') });
    expect(none.out).toContain('No sandboxing harness detected');
    expect(none.exitCode).toBe(undefined);

    expect(existsSync(claudeLocalSettingsPath(root))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux socket denial does not write a path-specific Claude allowance', () => {
  const root = scratch();
  try {
    const env = { CLAUDECODE: '1', STIM_HOME: join(root, 'home') };
    const notes: string[] = [];
    expect(applySandboxFix(root, env, (message) => notes.push(message), true, 'linux')).toBe(1);
    expect(existsSync(claudeLocalSettingsPath(root))).toBe(false);
    expect(notes.join(' ')).toContain('outside the sandbox');
    expect(sandboxFinding(root, { env, socketBlocked: true, platform: 'linux' })?.fix).toContain('outside the sandbox');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('socket allowance includes both the given and resolved paths', () => {
  const root = scratch();
  try {
    const real = join(root, 'real');
    const alias = join(root, 'alias');
    mkdirSync(real);
    symlinkSync(real, alias);
    const socket = join(alias, 'missing', 'run', 'stimd.sock');
    const resolved = join(realpathSync(real), 'missing', 'run', 'stimd.sock');
    const settings = join(root, 'settings.json');
    const write = (sockets: string[]) =>
      writeFileSync(settings, JSON.stringify({ sandbox: { network: { allowUnixSockets: sockets } } }));
    write([socket]);
    expect(missingAllowance([settings], root, root, socket)).toContain('sandbox.network.allowUnixSockets');
    write([socket, resolved]);
    expect(missingAllowance([settings], root, root, socket)).not.toContain('sandbox.network.allowUnixSockets');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
