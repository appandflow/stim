import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  desiredSlimLabels,
  encodeSlimStore,
  iosRuntimeKeepsOverrides,
  parsePrintDisabled,
  parseSlimProfile,
  parseSlimStore,
  slimDelta,
  writeSlimStore,
} from '../engine/simslim.ts';

const UDID = '0A1B2C3D-0000-4000-8000-0123456789AB';

test.each([
  ['com.apple.CoreSimulator.SimRuntime.iOS-18-5', true],
  ['com.apple.CoreSimulator.SimRuntime.iOS-18-3', false],
  ['27.0', true],
  ['18.5.1', true],
  ['18.3.1', false],
  ['17.5', false],
  ['18', false],
  [null, false],
])('the persistence gate for runtime %s is %s', (runtime, expected) => {
  expect(iosRuntimeKeepsOverrides(runtime)).toBe(expected);
});

test('profiles keep categories and labels enabled and reject unknown input', () => {
  const profile = parseSlimProfile('{"except":["store"],"keep":["com.apple.searchd"]}', 'p.json');
  const desired = desiredSlimLabels(profile);
  expect(desired.has('com.apple.apsd')).toBe(false);
  expect(desired.has('com.apple.searchd')).toBe(false);
  expect(desired.has('com.apple.swcd')).toBe(true);
  for (const required of ['com.apple.assistantd', 'com.apple.gamed', 'com.apple.sharingd']) {
    expect(desiredSlimLabels().has(required)).toBe(false);
  }
  expect(() => parseSlimProfile('{"excpet":[]}', 'p.json')).toThrow(/unknown field/);
  expect(() => parseSlimProfile('{"except":["nope"]}', 'p.json')).toThrow(/unknown category/);
  expect(() => parseSlimProfile('{"keep":["com.example.x"]}', 'p.json')).toThrow(/not a slimmable/);
  expect(() => parseSlimProfile('', 'p.json')).toThrow(/empty/);
});

test('the delta touches only managed labels and re-enables a required one a legacy run disabled', () => {
  const stored = new Map([
    ['com.apple.searchd', true],
    ['com.apple.assistantd', true],
    ['com.example.foreign', true],
    ['com.apple.swcd', false],
  ]);
  const delta = slimDelta(stored, new Set(['com.apple.searchd', 'com.apple.swcd', 'com.example.other']));
  expect(delta).toEqual({ toDisable: ['com.apple.swcd'], toEnable: ['com.apple.assistantd'] });
});

test('writing the store keeps foreign and explicit-false entries and lands mode 0644', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-simslim-'));
  try {
    const dir = join(root, `com.apple.CoreSimulator.SimDevice.${UDID}`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'disabled.plist'),
      encodeSlimStore(
        new Map([
          ['com.example.foreign', true],
          ['com.apple.swcd', false],
        ]),
      ),
    );
    writeSlimStore(UDID, { toDisable: ['com.apple.searchd'], toEnable: ['com.apple.swcd'] }, root);
    const written = parseSlimStore(readFileSync(join(dir, 'disabled.plist'), 'utf8'));
    expect(Object.fromEntries(written)).toEqual({
      'com.apple.searchd': true,
      'com.apple.swcd': false,
      'com.example.foreign': true,
    });
    expect(statSync(join(dir, 'disabled.plist')).mode & 0o777).toBe(0o644);
    expect(() => writeSlimStore('../etc', { toDisable: [], toEnable: [] }, root)).toThrow(/Refusing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('print-disabled output parses in both launchd spellings', () => {
  const output =
    'disabled services = {\n\t"com.apple.a" => disabled\n\t"com.apple.b" => enabled\n\t"com.apple.c" => true\n}';
  expect([...parsePrintDisabled(output)].toSorted()).toEqual(['com.apple.a', 'com.apple.c']);
});
