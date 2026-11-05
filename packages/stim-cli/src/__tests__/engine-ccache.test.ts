import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ccacheEnvironment,
  ccacheMaxSize,
  parseCcacheBinary,
  parseCcacheStatsLog,
  resolveCcache,
} from '../engine/ccache.ts';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-ccache-home-'));
  savedHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = savedHome;
});

describe('ccacheMaxSize', () => {
  test('passes caches.ccacheMaxGb to ccache as CCACHE_MAXSIZE and falls back to 5G on a bad value', () => {
    expect(ccacheMaxSize(null, {})).toBe('5G');
    expect(ccacheMaxSize(null, { STIM_CACHES_CCACHE_MAX_GB: '2.5' })).toBe('2.5G');
    expect(ccacheMaxSize({ version: 2, projects: {}, repos: {}, caches: { ccacheMaxGb: 8 } } as never, {})).toBe('8G');
    expect(ccacheMaxSize(null, { STIM_CACHES_CCACHE_MAX_GB: '0' })).toBe('5G');
    expect(
      ccacheEnvironment({ binary: '/b', dir: '/c', workspaceRoot: '/w', statsLog: '/l', maxSize: '2.5G' })
        .CCACHE_MAXSIZE,
    ).toBe('2.5G');
  });
});

describe('parseCcacheBinary', () => {
  test('takes the first line of the ccache PATH lookup and nothing else', () => {
    expect(parseCcacheBinary('/opt/homebrew/bin/ccache\n')).toBe('/opt/homebrew/bin/ccache');
    expect(parseCcacheBinary('/opt/homebrew/bin/ccache\n/usr/bin/ccache\n')).toBe('/opt/homebrew/bin/ccache');
  });
});

describe('parseCcacheStatsLog', () => {
  test('no cacheable compile at all reports nothing rather than a zero rate', () => {
    expect(parseCcacheStatsLog('')).toBe(null);
    expect(parseCcacheStatsLog('# a.cpp\ncalled_for_link\n')).toBe(null);
    expect(parseCcacheStatsLog(null)).toBe(null);
  });
});

describe('resolveCcache', () => {
  function project(root: string, buildGradle = 'apply plugin: "com.android.application"\n'): void {
    mkdirSync(join(root, 'android', 'app'), { recursive: true });
    writeFileSync(join(root, 'android', 'app', 'build.gradle'), buildGradle);
  }

  test('leaves a project that passes its own CMake launcher alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-ccache-root-'));
    project(root, 'arguments "-DCMAKE_CXX_COMPILER_LAUNCHER=ccache"\n');
    const notes: string[] = [];
    expect(resolveCcache({ root, lookup: () => '/opt/homebrew/bin/ccache', onNote: (line) => notes.push(line) })).toBe(
      null,
    );
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain(
      `ccache off (${join('android', 'app', 'build.gradle')} sets CMAKE_CXX_COMPILER_LAUNCHER`,
    );
    rmSync(root, { recursive: true, force: true });
  });
});
