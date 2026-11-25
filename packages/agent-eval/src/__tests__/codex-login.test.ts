import {
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

describe.skipIf(process.platform === 'win32')('codex login handling', () => {
  let root: string;
  let paths: TrialPaths;
  let real: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-login-'));
    const home = join(root, 'real-codex');
    mkdirSync(home);
    real = join(home, 'auth.json');
    writeFileSync(real, '{"tokens":{"refresh_token":"original-token-1"}}');
    const base = join(root, 'trial');
    paths = {
      roots: { home: root, claudeProjects: join(root, 'cp'), claudeTmp: join(root, 'ct'), codexHome: home },
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
    rmSync(root, { recursive: true, force: true });
  });

  test('the login is a link to the real file and a refresh that writes through it needs nothing from the runner', () => {
    const link = join(paths.codexHome, 'auth.json');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    writeFileSync(link, '{"tokens":{"refresh_token":"rotated-token-2"}}');
    expect(codexDriver.finish(paths)).toBeNull();
    expect(readFileSync(real, 'utf8')).toContain('rotated-token-2');
    expect(readdirSync(join(root, 'real-codex'))).toEqual(['auth.json']);
  });

  test('a link replaced by a file is moved next to the real login, privately, and the real login is untouched', () => {
    const link = join(paths.codexHome, 'auth.json');
    rmSync(link);
    writeFileSync(link, '{"tokens":{"refresh_token":"rotated-token-2"}}');
    const note = codexDriver.finish(paths);
    expect(note).toMatch(/codex login may be needed/);
    expect(readFileSync(real, 'utf8')).toContain('original-token-1');
    const moved = readdirSync(join(root, 'real-codex')).find((name) => name.startsWith('auth.json.eval-'));
    expect(readFileSync(join(root, 'real-codex', moved ?? ''), 'utf8')).toContain('rotated-token-2');
    expect(statSync(join(root, 'real-codex', moved ?? '')).mode & 0o777).toBe(0o600);
    expect(note).toContain(moved ?? 'missing');
    expect(existsSync(link)).toBe(false);
  });

  test('a real auth.json that is itself a link keeps its link; the moved file sits next to its target', () => {
    const dotfiles = join(root, 'dotfiles');
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, 'auth.json'), readFileSync(real));
    rmSync(real);
    symlinkSync(join(dotfiles, 'auth.json'), real);
    rmSync(paths.codexHome, { recursive: true });
    mkdirSync(paths.codexHome);
    codexDriver.prepare(paths, null);
    const link = join(paths.codexHome, 'auth.json');
    rmSync(link);
    writeFileSync(link, '{"x":1}');
    codexDriver.finish(paths);
    expect(lstatSync(real).isSymbolicLink()).toBe(true);
    expect(readdirSync(dotfiles).some((name) => name.startsWith('auth.json.eval-'))).toBe(true);
  });

  test('the permission profile lets git read the main repository of the linked trial workspace', () => {
    const { args } = codexDriver.command(paths, 'prompt', { model: null, bin: 'codex' });
    const profile = args.find((arg) => arg.startsWith('permissions.eval.filesystem='));
    expect(profile).toContain(`${JSON.stringify(join(paths.base, 'repo', '.git'))} = "read"`);
  });

  test('a missing link does not throw', () => {
    rmSync(join(paths.codexHome, 'auth.json'));
    expect(codexDriver.finish(paths)).toBeNull();
  });
});
