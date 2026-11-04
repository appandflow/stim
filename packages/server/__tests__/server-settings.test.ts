import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfigPath } from '@stim-cli/core/state';
import { watchServerSettings } from '../src/lan.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-server-settings-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const writeServer = (server: unknown) => writeFileSync(getConfigPath(), JSON.stringify({ server }));

test('server.keepAwake reaches its listener only for the boolean true, and a changed file is picked up', async () => {
  writeServer({ keepAwake: 'true' });
  const settings = watchServerSettings(20);
  try {
    await settings.ready;
    expect(settings.keepAwake()).toBe(false);
    const changes: boolean[] = [];
    settings.onKeepAwakeChange(() => changes.push(settings.keepAwake()));
    writeServer({ keepAwake: true, lanAddresses: ['en0'] });
    await vi.waitFor(() => expect(changes).toEqual([true]));
    expect(settings.current()).toEqual(['en0']);
    writeServer({ lanAddresses: ['en0'] });
    await vi.waitFor(() => expect(changes).toEqual([true, false]));
  } finally {
    settings.stop();
  }
});
