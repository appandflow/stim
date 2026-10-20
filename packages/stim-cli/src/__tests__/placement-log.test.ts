import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLogRecords, recordMatches } from '@stim-cli/core/state';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { validateSources } from '../commands/logs.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { buildPlacementRecord, devicePlacementRecord } from '../placement-log.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-placement-log-'));
  process.env.STIM_HOME = home;
  delete process.env.STIM_REMOTE_BUILD;
  delete process.env.STIM_REMOTE_BUILD_MODE;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  delete process.env.STIM_REMOTE_BUILD_MODE;
  rmSync(home, { recursive: true, force: true });
});

test('stim logs --source placement selects the records a run writes next to its build records', () => {
  const writer = createNdjsonWriter(join(home, 'build.ndjson'), { fields: { platform: 'ios', slot: 'default' } });
  writer.write({ src: 'build', level: 'info', msg: 'compiled' });
  writer.write(
    buildPlacementRecord({
      platform: 'ios',
      buildMachine: 'auto',
      candidates: [{ machine: 'mini', code: 'busy', msg: 'busy (all 2 build slots busy)', detail: ['busy'] }],
      fallback: { code: 'no-remote-mac-took-it', reason: 'mini: busy (all 2 build slots busy)' },
      event: 'placement_fallback',
    }),
  );
  writer.close();
  expect(validateSources(['placement'])).toEqual({ sources: ['placement'] });
  const [record, ...others] = readLogRecords(home).filter((each) => recordMatches(each, { sources: ['placement'] }));
  expect(others).toEqual([]);
  expect(record).toMatchObject({
    src: 'placement',
    level: 'warn',
    event: 'placement_fallback',
    kind: 'build',
    platform: 'ios',
    candidates: [{ machine: 'mini', code: 'busy' }],
    choice: { machine: 'local', code: 'no-remote-mac-took-it' },
    fallback: { code: 'no-remote-mac-took-it' },
  });
});

test('a build record names each setting that applied and the layer it came from', () => {
  process.env.STIM_REMOTE_BUILD_MODE = 'force';
  const record = buildPlacementRecord({
    platform: 'android',
    buildMachine: 'auto',
    chose: { machine: 'mini', reason: 'remote.buildMode is force' },
  });
  expect(record.settings).toEqual([
    { key: 'remote.build', value: 'auto', from: 'default' },
    { key: 'remote.buildMode', value: 'force', from: 'env' },
  ]);
  expect(record).toMatchObject({
    level: 'info',
    event: 'build_placement',
    choice: { machine: 'mini', code: 'placed' },
  });
});

test('a device record carries each skipped host with its code and the choice made', () => {
  const record = devicePlacementRecord({
    platform: 'ios',
    fromFlag: true,
    placed: {
      placement: { reason: 'load 5.0/core here' },
      code: 'no-host-admits',
      skipped: [{ machine: 'mini', code: 'unreachable', reason: 'did not answer hello in time' }],
    },
  });
  expect(record).toMatchObject({
    src: 'placement',
    event: 'device_placement',
    settings: [{ key: 'ios.remote', value: 'auto', from: 'flag' }],
    candidates: [{ machine: 'mini', code: 'unreachable', msg: 'did not answer hello in time' }],
    choice: { machine: 'local', code: 'no-host-admits' },
  });
});
