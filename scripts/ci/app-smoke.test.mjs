import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync }));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));

let directory;
beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  directory = mkdtempSync(join(tmpdir(), 'stim-ci-app-smoke-'));
  const result = join(directory, 'run.json');
  writeFileSync(
    result,
    JSON.stringify({ platform: 'ios', facts: { udid: 'owned-device', bundleId: 'com.example.app' } }),
  );
  vi.stubEnv('STIM_CI_RUN_RESULT', result);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function processLists(...lists) {
  execFileSync.mockImplementation((_file, args) => {
    if (args.includes('get_app_container')) return '/installed/app';
    return lists.length > 1 ? lists.shift() : lists[0];
  });
}

it('accepts the exact installed app staying alive alongside a sibling process', async () => {
  processLists('20 0 UIKitApplication:com.example.app.xctrunner[abc]\n21 0 UIKitApplication:com.example.app[def]');
  await expect(import('./app-smoke.mjs')).resolves.toBeDefined();
});

it.each(['20 0 UIKitApplication:com.example.app.xctrunner[abc]', '- 0 UIKitApplication:com.example.app[abc]'])(
  'refuses an installed app without its own live process: %s',
  async (list) => {
    processLists(list);
    await expect(import('./app-smoke.mjs')).rejects.toThrow('iOS app must have a running process');
  },
);

it('refuses an app that restarts during the smoke interval', async () => {
  processLists('21 0 UIKitApplication:com.example.app[abc]', '22 0 UIKitApplication:com.example.app[abc]');
  await expect(import('./app-smoke.mjs')).rejects.toThrow('App process restarted during the smoke interval');
});
