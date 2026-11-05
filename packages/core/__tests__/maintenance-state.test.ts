import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceDir, maintenanceStateFile } from '../state/paths.ts';
import { readMaintenanceState, type MaintenanceState } from '../state/maintenance.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-maintenance-state-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('status readers ignore missing, corrupt and unsupported maintenance state instead of failing status', () => {
  expect(readMaintenanceState()).toBeNull();
  mkdirSync(maintenanceDir());
  const state: MaintenanceState = {
    version: 1,
    lastAt: { pressure: 10 },
    pressure: null,
    sizes: [],
    lastPass: null,
    recent: [],
    plan: [],
  };
  for (const payload of [
    '{',
    'null',
    '[]',
    JSON.stringify({ ...state, version: 2 }),
    JSON.stringify({ ...state, pressure: {} }),
    JSON.stringify({ ...state, sizes: [null] }),
    JSON.stringify({ ...state, lastAt: { pressure: 'yesterday' } }),
    JSON.stringify({ ...state, plan: [{ kind: 'clear-outputs' }] }),
    JSON.stringify({
      ...state,
      recent: [{ src: 'maintenance', ts: 1, msg: 'corrupt record', event: 'maintenance_action' }],
    }),
  ]) {
    writeFileSync(maintenanceStateFile(), payload);
    expect(readMaintenanceState()).toBeNull();
  }
  writeFileSync(maintenanceStateFile(), JSON.stringify(state));
  expect(readMaintenanceState()).toEqual(state);
});
