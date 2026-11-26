import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, inject, test } from 'vitest';
import { agentDeviceDaemon } from '../devices/activity.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    agentDeviceBin: string;
  }
}

test('the start time agent-device records for its daemon identifies the live process', () => {
  if (process.platform !== 'darwin') throw new Error('Start-time compatibility requires macOS.');
  const bin = inject('agentDeviceBin');
  if (!bin)
    throw new Error('Compatibility requires agent-device at ~/.local/bin/agent-device or STIM_AGENT_DEVICE_BIN.');
  const dir = mkdtempSync(join(tmpdir(), 'stim-ad-start-'));
  const stateDir = join(dir, 'state');
  const run = (...args: string[]) =>
    execFileSync(bin, [...args, '--state-dir', stateDir, '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TZ: 'Pacific/Kiritimati', AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
    });
  try {
    run('session', 'list');
    expect(agentDeviceDaemon(stateDir)).toBe('live');
  } finally {
    run('daemon', 'stop');
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
