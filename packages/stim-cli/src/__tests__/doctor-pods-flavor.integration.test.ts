import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { inspectPodsFlavor } from '../diagnostics/doctor-pods-flavor.ts';

let dir: string;
let source: string;
let worktree: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-pods-flavor-'));
  source = join(dir, 'source', 'ios');
  worktree = join(dir, 'worktree', 'ios');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mark(ios: string, pod: string, configuration: string): void {
  const file = join(ios, 'Pods', pod, '.last_build_configuration');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, configuration);
}

function markAll(ios: string, configuration: string): void {
  for (const pod of ['React-Core-prebuilt', 'ReactNativeDependencies', 'hermes-engine']) mark(ios, pod, configuration);
}

test('a source built in Release against a Debug workspace is a note naming the pods and the source build', () => {
  markAll(source, 'Release');
  markAll(worktree, 'Release');
  const finding = inspectPodsFlavor(source, worktree, 'Debug');
  expect(finding).toMatchObject({ code: 'ios-pods-flavor', level: 'note' });
  expect(finding?.detail).toContain(
    'React-Core-prebuilt (Release), ReactNativeDependencies (Release), hermes-engine (Release)',
  );
  expect(finding?.detail).toContain('1 GB');
  expect(finding?.fix).toContain('`stim ios`');
});

test('the remedy names --configuration when the workspace builds Release', () => {
  markAll(source, 'Debug');
  markAll(worktree, 'Debug');
  expect(inspectPodsFlavor(source, worktree, 'Release')?.fix).toContain('`stim ios --configuration Release`');
});

test('a single mismatched pod is reported alone', () => {
  markAll(source, 'Debug');
  markAll(worktree, 'Debug');
  mark(source, 'hermes-engine', 'Release');
  mark(worktree, 'hermes-engine', 'Release');
  expect(inspectPodsFlavor(source, worktree, 'Debug')?.detail).toContain('hermes-engine (Release), but');
});

test('matching flavors report nothing', () => {
  markAll(source, 'Debug');
  markAll(worktree, 'Debug');
  expect(inspectPodsFlavor(source, worktree, 'Debug')).toBeNull();
});

test('missing marker files report nothing', () => {
  markAll(source, 'Release');
  expect(inspectPodsFlavor(source, worktree, 'Debug')).toBeNull();
  markAll(worktree, 'Release');
  rmSync(join(source, 'Pods'), { recursive: true });
  expect(inspectPodsFlavor(source, worktree, 'Debug')).toBeNull();
});

test('a project without prebuilt cores reports nothing', () => {
  mkdirSync(join(source, 'Pods', 'SDWebImage'), { recursive: true });
  mkdirSync(join(worktree, 'Pods', 'SDWebImage'), { recursive: true });
  expect(inspectPodsFlavor(source, worktree, 'Debug')).toBeNull();
});

test('a configuration React Native does not extract by name reports nothing', () => {
  markAll(source, 'Release');
  markAll(worktree, 'Release');
  expect(inspectPodsFlavor(source, worktree, 'Staging')).toBeNull();
});

test('a worktree that already swapped to the build configuration reports nothing', () => {
  markAll(source, 'Release');
  markAll(worktree, 'Debug');
  expect(inspectPodsFlavor(source, worktree, 'Debug')).toBeNull();
});
