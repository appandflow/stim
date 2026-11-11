import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * The React Native fixture contract (`fixture.json` in a fixture directory of the
 * appandflow/stim-benchmarks repository, see docs/benchmark-fixtures.md). Paths are
 * relative to the fixture directory.
 */
export const TRAILHEAD_FIXTURE = Object.freeze({
  schemaVersion: 1,
  kind: 'expo',
  name: 'Trailhead',
  ios: {
    bundleId: 'com.appandflow.trailhead',
    product: 'Trailhead',
    nativeChange: { file: 'ios/Trailhead/SceneDelegate.swift', anchor: 'class SceneDelegate: ExpoAppSceneDelegate {' },
  },
  android: {
    applicationId: 'com.appandflow.trailhead',
    nativeChange: { file: 'android/app/src/main/res/values/strings.xml', anchor: '<string name="app_name">' },
  },
  rootComponent: { file: 'app/_layout.tsx', declaration: 'export default function RootLayout() {', name: 'RootLayout' },
  proof: {
    screen: 'Settings',
    file: 'app/(tabs)/settings.tsx',
    row: 'Offline maps',
    rowLabel: 'offline-map subtitle',
    subtitle: 'Keep map tiles for saved trails on device',
    editedSubtitle: 'Keep saved trail maps available offline',
  },
});

const RN_KINDS = ['expo', 'bare'];
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

function relativePath(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('/') && !value.split('/').includes('..');
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\n');
}

export function assertReactNativeFixture(descriptor) {
  const d = descriptor ?? {};
  const problems = [];
  if (d.schemaVersion !== 1) problems.push('schemaVersion: 1');
  if (!RN_KINDS.includes(d.kind)) problems.push(`kind: ${RN_KINDS.join('|')}`);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(d.name ?? '')) problems.push('name');
  if (!IDENTIFIER.test(d.ios?.bundleId ?? '')) problems.push('ios.bundleId');
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(d.ios?.product ?? '')) problems.push('ios.product');
  if (!IDENTIFIER.test(d.android?.applicationId ?? '')) problems.push('android.applicationId');
  for (const platform of ['ios', 'android']) {
    const change = d[platform]?.nativeChange;
    if (!relativePath(change?.file) || !text(change?.anchor)) problems.push(`${platform}.nativeChange`);
  }
  const root = d.rootComponent;
  if (
    !relativePath(root?.file) ||
    !/^[A-Za-z][A-Za-z0-9]*$/.test(root?.name ?? '') ||
    root?.declaration !== `export default function ${root?.name}() {`
  ) {
    problems.push('rootComponent');
  }
  const proof = d.proof ?? {};
  if (!relativePath(proof.file)) problems.push('proof.file');
  for (const key of ['screen', 'row', 'rowLabel', 'subtitle', 'editedSubtitle']) {
    if (!text(proof[key]) || /["\\`$]/.test(proof[key])) problems.push(`proof.${key}`);
  }
  if (new Set([proof.row, proof.subtitle, proof.editedSubtitle]).size !== 3) problems.push('proof texts must differ');
  if (problems.length) throw new Error(`fixture.json is missing or invalid: ${problems.join(', ')}`);
  return d;
}

/**
 * Reads the fixture a benchmark root pins: `FIXTURES_COMMIT` and `FIXTURE_DIR` select a
 * directory of the stim-benchmarks checkout; without them the root serves Trailhead.
 */
export function benchmarkFixture(checkout, pins) {
  if (!pins.FIXTURE_DIR) {
    return { directory: '', commitPin: 'TRAILHEAD_FIXTURE_COMMIT', descriptor: TRAILHEAD_FIXTURE, app: checkout };
  }
  if (!relativePath(pins.FIXTURE_DIR) || pins.FIXTURE_DIR.includes('/')) {
    throw new Error(`FIXTURE_DIR must name one directory of the fixtures repository: ${pins.FIXTURE_DIR}`);
  }
  const app = join(checkout, pins.FIXTURE_DIR);
  const path = join(app, 'fixture.json');
  if (!existsSync(path)) throw new Error(`fixture descriptor missing: ${path}`);
  return {
    directory: pins.FIXTURE_DIR,
    commitPin: 'FIXTURES_COMMIT',
    descriptor: assertReactNativeFixture(JSON.parse(readFileSync(path, 'utf8'))),
    app,
  };
}

export function fixtureForRecord(meta) {
  return meta?.fixture?.descriptor ?? TRAILHEAD_FIXTURE;
}

export function fixtureDirectoryForRecord(meta) {
  return meta?.fixture?.directory ?? '';
}

/** A fixture path relative to the repository root, the form git reports. */
export function repositoryPath(directory, path) {
  return directory ? posix.join(directory, path) : path;
}

export function nativeChangeAnchorProblems(app, descriptor) {
  return ['ios', 'android'].flatMap((platform) => {
    const { file, anchor } = descriptor[platform].nativeChange;
    const path = join(app, file);
    if (!existsSync(path)) return [`${platform} native-change file is missing: ${file}`];
    const count = readFileSync(path, 'utf8').split(anchor).length - 1;
    return count === 1 ? [] : [`${platform} native-change anchor occurs ${count} times in ${file}`];
  });
}

export function settingsProofText(descriptor, variant) {
  return variant === 'javascript'
    ? descriptor.proof.editedSubtitle
    : variant === 'launch-crash'
      ? descriptor.proof.subtitle
      : descriptor.proof.row;
}

export function fixtureAppId(meta, platform = meta?.platform ?? 'ios') {
  const descriptor = fixtureForRecord(meta);
  return platform === 'android' ? descriptor.android.applicationId : descriptor.ios.bundleId;
}

export function nativeChangeMarker(meta) {
  return `${fixtureForRecord(meta).name} ${meta.runId}`;
}

/** The untimed Metro bundle that warms the control arm's transform cache for a fixture kind. */
export function metroBundleCommand(kind, platform, outputDir) {
  if (kind === 'bare') {
    return [
      'npx',
      [
        'react-native',
        'bundle',
        '--platform',
        platform,
        '--dev',
        'true',
        '--entry-file',
        'index.js',
        '--bundle-output',
        join(outputDir, `index.${platform}.bundle`),
        '--assets-dest',
        outputDir,
      ],
    ];
  }
  return ['npx', ['expo', 'export', '--platform', platform, '--dev', '--output-dir', outputDir]];
}
