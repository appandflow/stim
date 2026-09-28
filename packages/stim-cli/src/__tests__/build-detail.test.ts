import { readFileSync } from 'node:fs';
import { createBuildDetailParser, parseBuildToolLine } from '../engine/build-detail.ts';

function fixtureLines(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')
    .split('\n')
    .filter((line) => line && !line.startsWith('# '));
}

function replay(lines: string[]) {
  const parser = createBuildDetailParser();
  const details = lines.map((line) => {
    parser.push(line);
    return parser.detail('2026-09-27T10:00:00.000Z');
  });
  return { details, final: details.at(-1)! };
}

describe('xcodebuild output', () => {
  const lines = fixtureLines('xcodebuild-progress.txt');

  test('counts distinct targets against the dependency graph total and follows the step', () => {
    const { details, final } = replay(lines);
    const at = (prefix: string) => details[lines.findIndex((line) => line.startsWith(prefix))]!;

    expect(at('ComputeTargetDependencyGraph')).toMatchObject({ step: 'configure', done: null, total: null });
    expect(at('note: Target dependency graph')).toMatchObject({ unit: 'targets', done: 0, total: 237 });
    expect(at('PhaseScriptExecution')).toMatchObject({ step: 'script', done: 1 });
    expect(at('PhaseScriptExecution').line).toBe(
      'PhaseScriptExecution [CP-User] [Hermes] Replace Hermes for the right configuration, if needed (hermes-engine)',
    );
    expect(at('CompileC')).toMatchObject({ step: 'compile', line: 'CompileC sqlite3_vers.c (sqlite3)' });
    expect(at('Libtool')).toMatchObject({ step: 'link', line: 'Libtool sqlite3 (sqlite3)' });
    expect(at('CompileAssetCatalogVariant')).toMatchObject({
      step: 'resources',
      line: 'CompileAssetCatalogVariant Assets.xcassets (expo-dev-menu-EXDevMenu)',
    });
    expect(at('SwiftCompile')).toMatchObject({ step: 'compile', line: 'SwiftCompile (SwiftSVG)' });
    expect(final).toEqual({
      step: 'sign',
      unit: 'targets',
      done: 5,
      total: 237,
      line: 'CodeSign Notifications.debug.dylib (Notifications)',
      updatedAt: '2026-09-27T10:00:00.000Z',
    });
  });

  test('keeps the step and line through bookkeeping actions and compiler noise', () => {
    const parser = createBuildDetailParser();
    const compile = lines.find((line) => line.startsWith('CompileC'))!;
    const warning = lines.find((line) => line.includes('warning:'))!;
    const mkdir = lines.find((line) => line.startsWith('MkDir'))!;
    parser.push(compile);
    expect(parser.push(warning)).toBe(false);
    expect(parser.push(mkdir)).toBe(true);
    expect(parser.detail('t')).toMatchObject({ step: 'compile', line: 'CompileC sqlite3_vers.c (sqlite3)', done: 1 });
  });
});

describe('Gradle output', () => {
  test('counts task lines with no total and classifies tasks into steps', () => {
    const lines = fixtureLines('gradle-progress.txt');
    const { details, final } = replay(lines);
    const at = (text: string) => details[lines.findIndex((line) => line.includes(text))]!;

    expect(at('Configure project :app')).toMatchObject({ step: 'configure' });
    expect(at(':generateCodegenArtifactsFromSchema')).toMatchObject({ step: 'script', unit: 'tasks' });
    expect(at('mergeProductionDebugResources')).toMatchObject({ step: 'resources' });
    expect(at('mergeExtDexProductionDebug')).toMatchObject({ step: 'dex' });
    expect(at('buildCMakeDebug')).toMatchObject({
      step: 'compile',
      line: '> Task :react-native-worklets:buildCMakeDebug[arm64-v8a][worklets]',
    });
    expect(at('w: file:')).toEqual(at('buildCMakeDebug'));
    expect(final).toEqual({
      step: 'package',
      unit: 'tasks',
      done: 12,
      total: null,
      line: '> Task :app:assembleProductionDebug',
      updatedAt: '2026-09-27T10:00:00.000Z',
    });
  });
});

test('a run with no tool output reports no detail', () => {
  const parser = createBuildDetailParser();
  expect(parser.push('Installing React-Core (0.81.0)')).toBe(false);
  expect(parser.detail('t')).toBeNull();
  expect(parseBuildToolLine('BUILD SUCCESSFUL in 9m 44s')).toBeNull();
});
