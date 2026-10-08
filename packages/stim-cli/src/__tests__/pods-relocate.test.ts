import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { planPodsRelocation, relocatePath, relocatePods } from '../workspace/pods-relocate.ts';

const SOURCE = '/Users/dev/trailhead';
const PODSPEC = `{
  "name": "ExpoModulesCore",
  "version": "58.0.3",
  "source": {
    "http": "file://${SOURCE}/node_modules/expo-modules-core/prebuilds/output/debug/xcframeworks/ExpoModulesCore.tar.gz",
    "flatten": false
  }
}
`;
// shasum of PODSPEC, and of PODSPEC with the checkout path moved to /Users/dev/trailhead-wt.
const SEED_CHECKSUM = 'f4016125733e5d8681be92bad9dca2402410e321';
const COMMITTED_CHECKSUM = '8093bef5e1300c29caca315ee15670139f82e04c';

function lock({
  core = COMMITTED_CHECKSUM,
  version = '58.0.3',
  yoga = 'd1c536142c5ff8ec8cd856ab2a7c227a1d875c8e',
} = {}) {
  return `PODS:
  - ExpoModulesCore (${version})
  - Yoga (0.0.0)

DEPENDENCIES:
  - ExpoModulesCore (from \`../node_modules/expo/node_modules/expo-modules-core\`)

SPEC CHECKSUMS:
  ExpoLogBox: 4b6c8013f36ae1ea7c80e8e2af3230d4dd96b321
  ExpoModulesCore: ${core}
  Yoga: ${yoga}

PODFILE CHECKSUM: 2ca69401ed085bedf7a8383181b13b21f30274c0

COCOAPODS: 1.16.2
`;
}

const specs: Record<string, string> = { ExpoModulesCore: PODSPEC };
const readPodspec = (pod: string) => specs[pod] ?? null;

describe('planPodsRelocation', () => {
  test('accepts locks that differ only by the checksum of a podspec embedding the source path', () => {
    expect(
      planPodsRelocation({
        podfileLock: lock(),
        manifest: lock({ core: SEED_CHECKSUM }),
        sourceRoot: SOURCE,
        readPodspec,
      }),
    ).toEqual({ ok: true, pods: ['ExpoModulesCore'] });
  });

  test('refuses a changed pod version', () => {
    expect(
      planPodsRelocation({
        podfileLock: lock({ version: '58.0.4' }),
        manifest: lock({ core: SEED_CHECKSUM }),
        sourceRoot: SOURCE,
        readPodspec,
      }),
    ).toEqual({ ok: false });
  });

  test('refuses a checksum difference on a pod whose podspec does not embed the source path', () => {
    expect(
      planPodsRelocation({
        podfileLock: lock({ yoga: 'a'.repeat(40) }),
        manifest: lock({ core: COMMITTED_CHECKSUM }),
        sourceRoot: SOURCE,
        readPodspec: (pod) => (pod === 'Yoga' ? '{"name":"Yoga"}\n' : null),
      }),
    ).toEqual({ ok: false });
  });

  test('refuses when the carried checksum does not match the carried podspec', () => {
    expect(
      planPodsRelocation({
        podfileLock: lock(),
        manifest: lock({ core: 'b'.repeat(40) }),
        sourceRoot: SOURCE,
        readPodspec,
      }),
    ).toEqual({ ok: false });
  });

  test('refuses when the podspec embeds a different checkout path', () => {
    expect(
      planPodsRelocation({
        podfileLock: lock(),
        manifest: lock({ core: SEED_CHECKSUM }),
        sourceRoot: '/Users/dev/other',
        readPodspec,
      }),
    ).toEqual({ ok: false });
  });

  test('refuses identical locks', () => {
    expect(planPodsRelocation({ podfileLock: lock(), manifest: lock(), sourceRoot: SOURCE, readPodspec })).toEqual({
      ok: false,
    });
  });
});

describe('relocatePath', () => {
  test('rewrites the path and any -I prefix but not a longer sibling path', () => {
    const text = `A = "/Users/dev/trailhead/node_modules/x" -I/Users/dev/trailhead/y /Users/dev/trailhead2/z /tmp/Users/dev/trailhead/w`;
    expect(relocatePath(text, SOURCE, '/wt/trailhead')).toBe(
      `A = "/wt/trailhead/node_modules/x" -I/wt/trailhead/y /Users/dev/trailhead2/z /tmp/Users/dev/trailhead/w`,
    );
  });
});

describe('relocatePods', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'stim-pods-relocate-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function write(rel: string, value: string) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), value);
  }

  test('moves generated paths and symlinks, then makes Manifest.lock equal Podfile.lock', () => {
    const pods = 'ios/Pods';
    write('ios/Podfile.lock', lock());
    write(`${pods}/Manifest.lock`, lock({ core: SEED_CHECKSUM }));
    write(`${pods}/Local Podspecs/ExpoModulesCore.podspec.json`, PODSPEC);
    write(`${pods}/Target Support Files/A/A.xcconfig`, `HEADER_SEARCH_PATHS = "${SOURCE}/node_modules/a"\n`);
    write(`${pods}/Pods.xcodeproj/project.pbxproj`, `path = ${SOURCE}/node_modules/b;\n`);
    write(`${pods}/Other/untouched.txt`, `${SOURCE}/kept\n`);
    mkdirSync(join(base, pods, 'ExpoImage'), { recursive: true });
    symlinkSync(`${SOURCE}/node_modules/expo-image/X.xcframework`, join(base, pods, 'ExpoImage/X.xcframework'));
    symlinkSync('../relative', join(base, pods, 'ExpoImage/rel'));

    const result = relocatePods({
      podsDir: join(base, pods),
      podfileLockPath: join(base, 'ios/Podfile.lock'),
      sourceRoot: SOURCE,
      targetRoot: '/wt/trailhead',
    });

    expect(result).toEqual({ ok: true, pods: ['ExpoModulesCore'] });
    expect(readFileSync(join(base, pods, 'Manifest.lock'), 'utf-8')).toBe(lock());
    expect(readFileSync(join(base, pods, 'Target Support Files/A/A.xcconfig'), 'utf-8')).toBe(
      'HEADER_SEARCH_PATHS = "/wt/trailhead/node_modules/a"\n',
    );
    expect(readFileSync(join(base, pods, 'Pods.xcodeproj/project.pbxproj'), 'utf-8')).toBe(
      'path = /wt/trailhead/node_modules/b;\n',
    );
    expect(readFileSync(join(base, pods, 'Local Podspecs/ExpoModulesCore.podspec.json'), 'utf-8')).toContain(
      'file:///wt/trailhead/node_modules/',
    );
    expect(readlinkSync(join(base, pods, 'ExpoImage/X.xcframework'))).toBe(
      '/wt/trailhead/node_modules/expo-image/X.xcframework',
    );
    expect(readlinkSync(join(base, pods, 'ExpoImage/rel'))).toBe('../relative');
    expect(readFileSync(join(base, pods, 'Other/untouched.txt'), 'utf-8')).toBe(`${SOURCE}/kept\n`);
  });

  test('changes nothing when the locks differ for another reason', () => {
    const pods = 'ios/Pods';
    write('ios/Podfile.lock', lock({ version: '58.0.4' }));
    write(`${pods}/Manifest.lock`, lock({ core: SEED_CHECKSUM }));
    write(`${pods}/Local Podspecs/ExpoModulesCore.podspec.json`, PODSPEC);
    write(`${pods}/Target Support Files/A/A.xcconfig`, `${SOURCE}/x\n`);

    expect(
      relocatePods({
        podsDir: join(base, pods),
        podfileLockPath: join(base, 'ios/Podfile.lock'),
        sourceRoot: SOURCE,
        targetRoot: '/wt/trailhead',
      }),
    ).toEqual({ ok: false });
    expect(readFileSync(join(base, pods, 'Target Support Files/A/A.xcconfig'), 'utf-8')).toBe(`${SOURCE}/x\n`);
    expect(readFileSync(join(base, pods, 'Manifest.lock'), 'utf-8')).toBe(lock({ core: SEED_CHECKSUM }));
  });
});
