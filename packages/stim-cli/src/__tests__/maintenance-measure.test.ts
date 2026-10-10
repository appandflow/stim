import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { sharedCompilationCache } from '@stim-cli/core/state';
import { measurePressure, measureSizes, sizeScanDeferred } from '../maintenance/measure.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import * as hostMemory from '../host-memory.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig } from '../workspace/config.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { register } from '../cache/cache-manifest.ts';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    freemem: vi.fn<typeof original.freemem>(original.freemem),
    totalmem: vi.fn<typeof original.totalmem>(original.totalmem),
    loadavg: vi.fn<typeof original.loadavg>(original.loadavg),
  };
});

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(os.tmpdir(), 'stim-maintenance-measure-')));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('warning requires consecutive observations for the configured duration while critical counts immediately', () => {
  const settings = resolveMaintenanceSettings(null, {})!;
  const level = vi.spyOn(hostMemory, 'readHostMemoryPressure').mockReturnValue('warning');
  vi.spyOn(os, 'freemem').mockReturnValue(os.totalmem());
  const first = measurePressure(settings, null, 0);
  expect(first.memory.pressured).toBe(false);
  expect(first.warningSince).toBe(0);
  expect(measurePressure(settings, first, 599_999).memory.pressured).toBe(false);
  expect(measurePressure(settings, first, 600_000).memory.pressured).toBe(true);
  level.mockReturnValue('normal');
  const normal = measurePressure(settings, first, 600_000);
  expect(normal.warningSince).toBeNull();
  level.mockReturnValue('warning');
  expect(measurePressure(settings, normal, 600_001).memory.pressured).toBe(false);
  level.mockReturnValue('critical');
  expect(measurePressure(settings, normal, 600_001).memory.pressured).toBe(true);
  expect(measurePressure({ ...settings, memoryPressureLevel: 'off' }, first, 600_001).memory.pressured).toBe(false);
  level.mockReturnValue('warning');
  expect(measurePressure({ ...settings, memoryPressureLevel: 'critical' }, first, 600_001).memory.pressured).toBe(
    false,
  );
});

test.skipIf(process.platform === 'darwin')(
  'available memory uses 10 percent of RAM when unset and honors an explicit threshold',
  () => {
    const settings = resolveMaintenanceSettings(null, {})!;
    vi.spyOn(hostMemory, 'readHostMemoryPressure').mockReturnValue(null);
    vi.spyOn(os, 'totalmem').mockReturnValue(20 * 1024 ** 3);
    vi.spyOn(os, 'freemem').mockReturnValue(1024 ** 3);
    expect(measurePressure(settings, null, 0).memory.pressured).toBe(true);
    expect(measurePressure({ ...settings, minAvailableMemoryGb: 0 }, null, 0).memory.pressured).toBe(false);
  },
);

test('high load defers scans and every measured output/cache uses a bounded du call without deleting data', () => {
  const app = join(home, 'app');
  mkdirSync(app);
  saveConfig({ projects: { [app]: {} }, repos: {} });
  const workspace = ensureWorkspaceStorage(app);
  mkdirSync(join(workspace, 'derived-data'));
  const cas = sharedCompilationCache();
  mkdirSync(cas);
  const sentinel = join(cas, 'keep');
  writeFileSync(sentinel, 'cache bytes');
  const registered = join(home, 'registered');
  mkdirSync(registered);
  register({ dir: registered, name: 'Test cache', prune: 'entries' });
  const calls: { file: string; args: readonly string[]; timeout: number | undefined }[] = [];
  setExecutor({
    runFile: (file, args, opts) => {
      calls.push({ file, args, timeout: opts?.timeoutMs });
      if (file === 'du') return `123\t${args[1]}\n`;
      return '';
    },
    runFileQuiet: () => null,
    runQuiet: () => null,
    findExecutable: () => null,
  });
  const load = vi.spyOn(os, 'loadavg').mockReturnValue([os.cpus().length * 5, 0, 0]);
  expect(sizeScanDeferred(resolveMaintenanceSettings(null, {})!)).toBe(true);
  load.mockReturnValue([0, 0, 0]);
  expect(sizeScanDeferred(resolveMaintenanceSettings(null, {})!)).toBe(false);
  const failures: string[] = [];
  const sizes = measureSizes(100, (target) => failures.push(target));
  expect(sizes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ category: 'workspace-outputs', workspace: app, bytes: 123 * 1024, measuredAt: 100 }),
      expect.objectContaining({ category: 'compilation-cache', dir: cas, bytes: 123 * 1024 }),
      expect.objectContaining({ category: 'other', dir: registered, bytes: 123 * 1024 }),
    ]),
  );
  expect(failures).toEqual([]);
  const duCalls = calls.filter((call) => call.file === 'du');
  expect(duCalls.length).toBeGreaterThanOrEqual(3);
  for (const call of duCalls) {
    expect(call.args[0]).toBe('-sk');
    expect(call.timeout).toBe(120_000);
  }
  expect(existsSync(sentinel)).toBe(true);
});
