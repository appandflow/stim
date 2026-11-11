import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { launchCrashRepair, launchCrashToken } from '../launch-crash-benchmark.mjs';
import { createNativeFixture, exactFixture } from './native-fixtures.mjs';
import { injectNativeCrash, nativeCrashPlan, nativeCrashReproduced } from './native-crash-setup.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const token = launchCrashToken('run-1');

describe('native launch crash injection', () => {
  it('injects into the Swift app shared by iOS and macOS and restores byte for byte', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-native-crash-'));
    dirs.push(root);
    const fixture = createNativeFixture('macos', join(root, 'mac'));
    const original = readFileSync(join(root, 'mac', fixture.source), 'utf8');
    const crashed = injectNativeCrash(original, nativeCrashPlan(fixture), token);
    expect(crashed).toContain(`fatalError("${token}")`);
    expect(crashed.indexOf('init()')).toBeLessThan(crashed.indexOf('var body'));
    const sha = createHash('sha256').update(original).digest('hex');
    expect(launchCrashRepair(crashed, token, sha).valid).toBe(false);
    expect(launchCrashRepair(original, token, sha).valid).toBe(true);
  });

  it('throws from the Kotlin activity before setContent', () => {
    expect(() => nativeCrashPlan({ framework: 'native-gradle', source: 'x.kt' })).not.toThrow();
    const crashed = injectNativeCrash(
      'class A {\n  override fun onCreate(state: Bundle?) {\n    super.onCreate(state)\n    setContent {}\n  }\n}\n',
      { kind: 'kotlin' },
      token,
    );
    expect(crashed.indexOf(token)).toBeLessThan(crashed.indexOf('setContent'));
  });

  it('refuses an ambiguous or missing anchor and a reused token', () => {
    expect(() => injectNativeCrash('struct Other {}\n', { kind: 'swift' }, token)).toThrow(/anchor was not found/);
    expect(() => injectNativeCrash(`x\n${token}`, { kind: 'swift' }, token)).toThrow(/already present/);
    expect(() => injectNativeCrash('a', { kind: 'swift' }, 'TOKEN')).toThrow(/unexpected format/);
  });

  it('takes the Exact crash site from the fixture description', () => {
    const plan = nativeCrashPlan({
      framework: 'exact',
      crash: { source: 'src/main.rs', anchor: 'fn app_start() {', language: 'rust' },
    });
    expect(injectNativeCrash('fn app_start() {\n    run();\n}\n', plan, token)).toBe(
      `fn app_start() {\npanic!("${token}");\n    run();\n}\n`,
    );
    expect(() => nativeCrashPlan({ framework: 'exact' })).toThrow(/crash:/);
  });
});

const command = (text, output, offset) => ({ command: text, output, startEventOffset: offset });

const checkoutWith = (value) => {
  const checkout = mkdtempSync(join(tmpdir(), 'bench-exact-fixture-'));
  onTestFinished(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, 'exact'));
  writeFileSync(join(checkout, 'exact', 'fixture.json'), JSON.stringify(value));
  return checkout;
};

describe('Exact fixture description', () => {
  const descriptor = {
    schemaVersion: 1,
    framework: 'exact',
    platform: 'ios',
    app: 'stim-bench-exact',
    source: 'app.contract',
    product: 'Acceptance',
    bundleId: 'dev.example.acceptance',
    crash: { source: 'app.ts', anchor: 'fn app_start() {', language: 'rust' },
  };
  it('keeps the app in a folder named after it inside any checkout of the fixtures repository', () => {
    const checkout = checkoutWith(descriptor);
    expect(exactFixture(checkout, 'a'.repeat(40))).toMatchObject({
      appDirectory: 'exact/stim-bench-exact',
      fixtureDirectory: join(checkout, 'exact', 'stim-bench-exact'),
    });
  });
  it('names what a missing field or pin is before a run starts', () => {
    expect(() => exactFixture(checkoutWith(descriptor), 'main')).toThrow(/FIXTURES_COMMIT/);
    expect(() => exactFixture(checkoutWith({ ...descriptor, app: '../x' }), 'a'.repeat(40))).toThrow(/app/);
    expect(() => exactFixture(checkoutWith({ ...descriptor, crash: undefined }), 'a'.repeat(40))).toThrow(/crash:/);
  });
});

describe('native crash reproduction evidence', () => {
  it('accepts a launch whose output carries the token before the source is read', () => {
    expect(
      nativeCrashReproduced([command('xcrun simctl launch X app', `Fatal error: ${token}`, 1)], {
        token,
        source: 'NativeAcceptance.swift',
      }).valid,
    ).toBe(true);
  });
  it('rejects a capture that follows reading the source and a run with no capture', () => {
    const source = 'NativeAcceptance.swift';
    expect(
      nativeCrashReproduced([command('cat NativeAcceptance.swift', 'init() {}', 1), command('launch', token, 2)], {
        token,
        source,
      }).reason,
    ).toBe('native-crash-source-inspected-before-capture');
    for (const history of [
      'git show HEAD',
      'cd w && git log -p',
      'git checkout HEAD~1 -- App.swift',
      'git diff HEAD~1',
    ]) {
      expect(nativeCrashReproduced([command(history, `commit ${token}`, 1)], { token, source }).reason).toBe(
        'native-crash-source-inspected-before-capture',
      );
    }
    expect(
      nativeCrashReproduced([command('git worktree add -b b /w HEAD', '', 1), command('launch', token, 2)], {
        token,
        source,
      }).valid,
    ).toBe(true);
    expect(nativeCrashReproduced([command('launch', 'ok', 1)], { token, source }).reason).toBe(
      'native-crash-not-captured',
    );
  });
});
