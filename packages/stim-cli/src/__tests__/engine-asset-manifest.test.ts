import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSET_MANIFEST_VERSION,
  assetDiffReason,
  captureAssetManifest,
  compareAssetManifests,
  findGeneratedResDir,
  parseAssetManifest,
  pickGeneratedResDir,
  type AssetManifest,
} from '../engine/asset-manifest.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-assets-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(file: string, contents: string) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

describe('parseAssetManifest', () => {
  test('anything unrecognised is NO manifest, never an empty one', () => {
    expect(parseAssetManifest('not json')).toBe(null);
    expect(parseAssetManifest(null)).toBe(null);
    expect(parseAssetManifest('[]')).toBe(null);
    expect(parseAssetManifest(JSON.stringify({ version: 2, assets: [] }))).toBe(null);
    expect(parseAssetManifest(JSON.stringify({ version: 1 }))).toBe(null);
    expect(parseAssetManifest(JSON.stringify({ version: 1, assets: [{ path: 'a.png' }] }))).toBe(null);
    expect(parseAssetManifest(JSON.stringify({ version: 1, assets: [] }))).toEqual({ version: 1, assets: [] });
  });
});

describe('pickGeneratedResDir', () => {
  const modern = ['createBundleDebugJsAndAssets', 'createBundleProductionReleaseJsAndAssets'];

  test('older layout: react/<variant>', () => {
    expect(pickGeneratedResDir(['react'], 'productionRelease', ['debug', 'productionRelease'])).toBe(
      'react/productionRelease',
    );
    expect(pickGeneratedResDir(['react'], 'release', ['debug'])).toBe(null);
  });

  test('with no variant to match, exactly one candidate is unambiguous and several are not', () => {
    expect(pickGeneratedResDir(['createBundleReleaseJsAndAssets'], null)).toBe('createBundleReleaseJsAndAssets');
    expect(pickGeneratedResDir(modern, null)).toBe(null);
    expect(pickGeneratedResDir(['react'], null, ['release'])).toBe('react/release');
    expect(pickGeneratedResDir(['react'], null, ['debug', 'release'])).toBe(null);
  });
});

describe('findGeneratedResDir', () => {
  test('the app module first, in the RN 0.71+ layout', () => {
    const dir = join(root, 'android', 'app', 'build', 'generated', 'res', 'createBundleReleaseJsAndAssets');
    write(join(dir, 'drawable-mdpi', 'logo.png'), 'png');
    expect(findGeneratedResDir(root, 'release')).toBe(dir);
  });
});

describe('captureAssetManifest', () => {
  test("a release build's emitted tree becomes the manifest stored beside the artifact", () => {
    const dir = join(root, 'android', 'app', 'build', 'generated', 'res', 'createBundleProductionReleaseJsAndAssets');
    write(join(dir, 'drawable-mdpi', 'logo.png'), 'png');
    write(join(dir, 'raw', 'sound.mp3'), 'mp3');
    expect(captureAssetManifest(root, { variant: 'productionRelease' })).toEqual({
      version: ASSET_MANIFEST_VERSION,
      assets: [
        { path: 'drawable-mdpi/logo.png', sha256: sha('png') },
        { path: 'raw/sound.mp3', sha256: sha('mp3') },
      ],
    });
  });

  test('nothing generated means no manifest -- and an entry with no manifest never swaps', () => {
    expect(captureAssetManifest(root, { variant: 'release' })).toBe(null);
  });
});

describe('compareAssetManifests', () => {
  const stored: AssetManifest = {
    version: 1,
    assets: [
      { path: 'drawable-mdpi/logo.png', sha256: sha('logo') },
      { path: 'raw/sound.mp3', sha256: sha('sound') },
    ],
  };

  test('ADDED: a fresh require() the cached APK cannot serve', () => {
    const fresh: AssetManifest = {
      version: 1,
      assets: [...stored.assets, { path: 'drawable-mdpi/new.png', sha256: sha('new') }],
    };
    const diff = compareAssetManifests(fresh, stored);
    expect(diff.same).toBe(false);
    expect(diff.added).toEqual(['drawable-mdpi/new.png']);
    expect(diff.example).toBe('drawable-mdpi/new.png');
    expect(assetDiffReason(diff)).toMatch(/1 added, 0 changed, 0 removed; e\.g\. added drawable-mdpi\/new\.png/);
  });

  test('CHANGED: the same filename, different bytes -- issue #62, and what names-only could not see', () => {
    const fresh: AssetManifest = {
      version: 1,
      assets: [{ path: 'drawable-mdpi/logo.png', sha256: sha('a DIFFERENT logo') }, stored.assets[1]!],
    };
    const diff = compareAssetManifests(fresh, stored);
    expect(diff.same).toBe(false);
    expect(diff.changed).toEqual(['drawable-mdpi/logo.png']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(assetDiffReason(diff)).toMatch(/e\.g\. changed drawable-mdpi\/logo\.png/);
  });
});
