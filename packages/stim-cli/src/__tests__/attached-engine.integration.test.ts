import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindCIEngine } from '../stimd/attached.ts';

const select = vi.hoisted(() => vi.fn<(env: NodeJS.ProcessEnv) => string | null>());
const load = vi.hoisted(() => vi.fn<(dir: string) => Promise<((name: string) => Promise<string>) | null>>());
const local = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../api/engine-route.ts', () => ({
  selectedEngineDir: select,
  loadEngineRunOp: load,
}));
vi.mock('../api.ts', () => ({ runOp: local }));

beforeEach(() => load.mockImplementation(async (dir) => async () => dir));
afterEach(() => {
  load.mockReset();
  local.mockReset();
});

test('hosts through the selected engine with the chosen environment and options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-selected-engine-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(
      join(root, 'dist', 'attached-stimd.mjs'),
      `export async function hostStimd(env, options) { return { env, options }; }`,
    );
    select.mockReturnValue(root);
    const env = { STIM_HOME: join(root, 'home') };
    const binding = await bindCIEngine(env);
    expect(await binding.host(env, { handover: false })).toEqual({ env, options: { handover: false } });
    expect(select).toHaveBeenCalledWith(env);
  } finally {
    rmSync(root, { recursive: true, force: true });
    select.mockReset();
  }
});

test('refuses a selected engine without attached hosting and names the update remedy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-old-engine-'));
  try {
    select.mockReturnValue(root);
    await expect(bindCIEngine({})).rejects.toMatchObject({
      code: 'STIM_ENGINE_HOST_UNAVAILABLE',
      remedy: expect.stringContaining('stim engine update'),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    select.mockReset();
  }
});

test.each([true, false])('keeps the selected operations when the pointer changes (selected: %s)', async (hasEngine) => {
  const root = mkdtempSync(join(tmpdir(), 'stim-pin-engine-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'attached-stimd.mjs'), 'export function hostStimd() {}');
    select.mockReturnValue(hasEngine ? root : null);
    local.mockResolvedValue('local');
    const binding = await bindCIEngine({});
    select.mockReturnValue(join(root, 'new-engine'));
    expect(await binding.runOp('run', [], {})).toBe(hasEngine ? root : 'local');
    expect(await binding.runOp('stop', [], {})).toBe(hasEngine ? root : 'local');
  } finally {
    rmSync(root, { recursive: true, force: true });
    select.mockReset();
  }
});
