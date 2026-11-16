import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { codexDriver } from '../drivers/codex.ts';
import type { TrialPaths } from '../types.ts';

describe.skipIf(process.platform === 'win32')('codex login write-back', () => {
  let root: string;
  let previous: string | undefined;
  let paths: TrialPaths;
  let real: string;
  const quarantineDir = () => join(root, 'results', 'codex-login');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-login-'));
    previous = process.env.CODEX_HOME;
    const home = join(root, 'real-codex');
    mkdirSync(home);
    real = join(home, 'auth.json');
    writeFileSync(real, '{"tokens":{"refresh_token":"original-token-1"}}');
    process.env.CODEX_HOME = home;
    const base = join(root, 'trial');
    paths = {
      base,
      workspace: join(base, 'workspace'),
      bin: join(base, 'bin'),
      harness: join(base, 'harness'),
      stimHome: join(base, 'stim-home'),
      home: join(base, 'home'),
      codexHome: join(base, 'codex-home'),
    };
    for (const dir of [paths.home, paths.codexHome]) mkdirSync(dir, { recursive: true });
    codexDriver.prepare(paths, null);
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    chmodSync(join(root, 'real-codex'), 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  function refresh(content: string): void {
    const link = join(paths.codexHome, 'auth.json');
    rmSync(link);
    writeFileSync(link, content);
  }

  test('a valid refreshed login replaces the real one through a temp file and leaves no temp file', () => {
    refresh('{"tokens":{"refresh_token":"rotated-token-2"}}');
    expect(codexDriver.finish(paths, { killed: false, quarantineDir: quarantineDir() })).toBeNull();
    expect(readFileSync(real, 'utf8')).toContain('rotated-token-2');
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, 'real-codex'))).toEqual(['auth.json']);
  });

  test('a real auth.json that is a symlink keeps its link and updates its target', () => {
    const target = join(root, 'dotfiles-auth.json');
    writeFileSync(target, readFileSync(real));
    rmSync(real);
    symlinkSync(target, real);
    rmSync(paths.codexHome, { recursive: true });
    mkdirSync(paths.codexHome);
    codexDriver.prepare(paths, null);
    refresh('{"tokens":{"refresh_token":"rotated-token-2"}}');
    expect(codexDriver.finish(paths, { killed: false, quarantineDir: quarantineDir() })).toBeNull();
    expect(lstatSync(real).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('rotated-token-2');
  });

  test.each([
    ['the run was killed', '{"tokens":{"refresh_token":"rotated-token-2"}}', true, false],
    ['the refreshed file is truncated', '{"tokens":{"refresh_tok', false, false],
    ['the real login changed meanwhile', '{"tokens":{"refresh_token":"rotated-token-2"}}', false, true],
  ])('%s: the real login is untouched and the copy is private', (_, content, killed, changed) => {
    refresh(content);
    if (changed) writeFileSync(real, '{"tokens":{"refresh_token":"newer-from-another-session"}}');
    const before = readFileSync(real, 'utf8');
    const note = codexDriver.finish(paths, { killed, quarantineDir: quarantineDir() });
    expect(note).toMatch(/codex login/);
    expect(readFileSync(real, 'utf8')).toBe(before);
    const [copy] = readdirSync(quarantineDir());
    expect(statSync(quarantineDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(quarantineDir(), copy ?? '')).mode & 0o777).toBe(0o600);
    expect(note).toContain(quarantineDir());
  });

  test('an unchanged login needs nothing and a missing link does not throw', () => {
    rmSync(join(paths.codexHome, 'auth.json'));
    expect(codexDriver.finish(paths, { killed: false, quarantineDir: quarantineDir() })).toBeNull();
    expect(existsSync(quarantineDir())).toBe(false);
  });

  test('a write that fails falls back to the private copy and leaves no temp file', () => {
    refresh('{"tokens":{"refresh_token":"rotated-token-2"}}');
    chmodSync(join(root, 'real-codex'), 0o500);
    const note = codexDriver.finish(paths, { killed: false, quarantineDir: quarantineDir() });
    chmodSync(join(root, 'real-codex'), 0o700);
    expect(note).toMatch(/writing the real auth.json failed/);
    expect(readdirSync(join(root, 'real-codex'))).toEqual(['auth.json']);
    expect(readFileSync(real, 'utf8')).toContain('original-token-1');
  });
});
