import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  TRAILHEAD_FIXTURE,
  assertReactNativeFixture,
  benchmarkFixture,
  metroBundleCommand,
  nativeChangeAnchorProblems,
} from './fixture.mjs';
import { benchmarkTaskPrompt } from './task-prompt.mjs';

const calculator = {
  ...TRAILHEAD_FIXTURE,
  kind: 'bare',
  name: 'StimBench',
  ios: {
    bundleId: 'com.appandflow.stimbench',
    product: 'StimBench',
    nativeChange: { file: 'ios/StimBench/SceneDelegate.swift', anchor: 'window = UIWindow(windowScene: windowScene)' },
  },
  android: { ...TRAILHEAD_FIXTURE.android, applicationId: 'com.appandflow.stimbench' },
  rootComponent: {
    file: 'src/StimBenchRoot.tsx',
    declaration: 'export default function StimBenchRoot() {',
    name: 'StimBenchRoot',
  },
  proof: {
    screen: 'Settings',
    file: 'src/screens/SettingsScreen.tsx',
    row: 'Key haptics',
    rowLabel: 'key-haptics subtitle',
    subtitle: 'Vibrate softly on every key press',
    editedSubtitle: 'Play a light tap on every key press',
  },
};

const prompt = (fixture, appDirectory) =>
  benchmarkTaskPrompt({
    arm: 'stim',
    platform: 'ios',
    variant: 'javascript',
    source: '/f',
    worktree: '/w',
    branch: 'b',
    marker: 'm',
    device: 'd',
    proof: 'p',
    fixture,
    appDirectory,
  });

function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), 'bench-fixture-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

describe('fixture descriptor', () => {
  it('serves Trailhead without a fixture directory pin and the pinned descriptor otherwise', () => {
    expect(benchmarkFixture('/trailhead', {})).toMatchObject({
      directory: '',
      app: '/trailhead',
      commitPin: 'TRAILHEAD_FIXTURE_COMMIT',
      descriptor: TRAILHEAD_FIXTURE,
    });
    const root = checkout({ 'bare/fixture.json': JSON.stringify(calculator) });
    expect(benchmarkFixture(root, { FIXTURE_DIR: 'bare' })).toMatchObject({
      directory: 'bare',
      app: join(root, 'bare'),
      commitPin: 'FIXTURES_COMMIT',
      descriptor: calculator,
    });
    expect(() => benchmarkFixture(root, { FIXTURE_DIR: '../bare' })).toThrow(/FIXTURE_DIR/);
  });

  it('refuses a descriptor whose injection anchor or proof texts cannot work', () => {
    expect(assertReactNativeFixture(calculator)).toBe(calculator);
    expect(() =>
      assertReactNativeFixture({
        ...calculator,
        rootComponent: { ...calculator.rootComponent, declaration: 'export default function App() {' },
      }),
    ).toThrow(/rootComponent/);
    expect(() =>
      assertReactNativeFixture({ ...calculator, proof: { ...calculator.proof, editedSubtitle: calculator.proof.row } }),
    ).toThrow(/proof texts must differ/);
  });

  it('reports a native-change anchor the fixture lost or repeats', () => {
    const anchor = calculator.ios.nativeChange.anchor;
    const strings = '<string name="app_name">StimBench</string>';
    expect(
      nativeChangeAnchorProblems(
        checkout({
          'ios/StimBench/SceneDelegate.swift': `${anchor}\n`,
          'android/app/src/main/res/values/strings.xml': strings,
        }),
        calculator,
      ),
    ).toEqual([]);
    expect(
      nativeChangeAnchorProblems(
        checkout({
          'ios/StimBench/SceneDelegate.swift': `${anchor}\n${anchor}\n`,
          'android/app/src/main/res/values/strings.xml': '',
        }),
        calculator,
      ),
    ).toEqual([
      'ios native-change anchor occurs 2 times in ios/StimBench/SceneDelegate.swift',
      'android native-change anchor occurs 0 times in android/app/src/main/res/values/strings.xml',
    ]);
  });

  it('warms the control Metro cache with the bundler the fixture kind has', () => {
    expect(metroBundleCommand('expo', 'ios', '/out')).toEqual([
      'npx',
      ['expo', 'export', '--platform', 'ios', '--dev', '--output-dir', '/out'],
    ]);
    const [command, args] = metroBundleCommand('bare', 'android', '/out');
    expect([command, ...args.slice(0, 4)]).toEqual(['npx', 'react-native', 'bundle', '--platform', 'android']);
    expect(args).not.toContain('expo');
  });

  it("writes the app-launch task from the fixture's proof row and names the app directory", () => {
    expect(prompt(TRAILHEAD_FIXTURE, '')).toContain(
      'Change the Settings offline-map subtitle from "Keep map tiles for saved trails on device" to "Keep saved trail maps available offline".',
    );
    const calculatorPrompt = prompt(calculator, 'bare');
    expect(calculatorPrompt).toContain('The app is the bare directory of the worktree.');
    expect(calculatorPrompt).toContain(
      'Change the Settings key-haptics subtitle from "Vibrate softly on every key press" to "Play a light tap on every key press".',
    );
  });
});
