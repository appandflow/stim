import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentDeviceUsageFile,
  readAgentDeviceUsage,
  readStatsReport,
  readSwiftpmCacheUsage,
  swiftpmCacheUsageFile,
  type AgentDeviceUsage,
} from '../state/index.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-core-agent-usage-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('core stats reads only the cached measurement, tolerates additive fields and rejects corrupt or unsupported payloads', () => {
  const state = join(home, '.agent-device');
  const usage: AgentDeviceUsage = {
    version: 1,
    measuredAt: '2026-10-05T17:44:35.000Z',
    bytes: 4600000000,
    complete: false,
    stateDir: {
      dir: state,
      present: true,
      bytes: 4600000000,
      sessions: { dir: join(state, 'sessions'), bytes: 100000000, count: 545 },
      logs: { dir: join(state, 'logs'), bytes: 14000000 },
      other: { bytes: null, largest: [] },
    },
    runnerBuilds: { dir: join(state, 'apple-runner'), present: true, bytes: null, sharedBytes: null, platforms: [] },
    workspaces: [],
    hosted: null,
  };
  mkdirSync(state);
  writeFileSync(join(state, 'unmeasured'), 'never scanned');
  expect(readStatsReport(null, Date.now()).report.agentDevice).toBe(null);
  writeFileSync(agentDeviceUsageFile(), JSON.stringify({ ...usage, roots: {}, futureField: true }));
  expect(readStatsReport(null, Date.now()).report.agentDevice).toMatchObject(usage);
  for (const raw of [
    '{',
    'null',
    JSON.stringify({ ...usage, version: 0 }),
    JSON.stringify({ ...usage, stateDir: {} }),
    JSON.stringify({ ...usage, bytes: -1 }),
  ]) {
    writeFileSync(agentDeviceUsageFile(), raw);
    expect(readAgentDeviceUsage()).toBe(null);
  }
});

test('the unscoped gc documentation example supplies valid agent-device and SwiftPM payloads', () => {
  const docs = readFileSync(new URL('../../../website/docs/commands.md', import.meta.url), 'utf8');
  const example = docs.split('`stim gc --worktrees --json`')[1]!.split('```json')[1]!.split('```')[0]!;
  const report = JSON.parse(example);
  expect(report.cacheScope).toBe(null);
  expect(report.sections.agentDevice).not.toBe(null);
  expect(report.sections.swiftpmCache).not.toBe(null);
  writeFileSync(agentDeviceUsageFile(), JSON.stringify(report.sections.agentDevice));
  writeFileSync(swiftpmCacheUsageFile(), JSON.stringify(report.sections.swiftpmCache));
  expect(readAgentDeviceUsage()).toEqual(report.sections.agentDevice);
  expect(readSwiftpmCacheUsage()).toEqual(report.sections.swiftpmCache);
});
