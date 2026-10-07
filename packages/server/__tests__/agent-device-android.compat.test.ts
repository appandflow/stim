import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';
import { AgentDeviceDriver } from '../src/agent-device-driver.ts';
import { adbPath } from '../src/frame-helper.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    agentDeviceAndroidSerial: string;
  }
}

test('the real Android daemon enforces serial inventory, commands and shutdown policy', async () => {
  const serial = inject('agentDeviceAndroidSerial').trim();
  if (!/^emulator-[0-9]+$/.test(serial))
    throw new Error(
      'Compatibility requires STIM_AGENT_DEVICE_ANDROID_SERIAL naming an exclusively owned test emulator.',
    );
  const { stdout } = await promisify(execFile)(adbPath(process.env), ['-s', serial, 'emu', 'avd', 'name'], {
    timeout: 2000,
    killSignal: 'SIGKILL',
  });
  const avdName = stdout.split('\n')[0]!.trim();
  const home = mkdtempSync(join(tmpdir(), 'stim-android-agent-compat-'));
  process.env.STIM_HOME = home;
  const session = '11111111-1111-4111-8111-111111111111';
  const stateDir = join(home, 'agent');
  const driver = new AgentDeviceDriver({
    env: process.env,
    stateDir,
    claimRoot: join(home, 'claims'),
    device: { session, serial, avdName },
  });
  try {
    await driver.start();
    await expect(
      driver.issue({ client: 'c', session, serial, avdName, bundleId: 'dev.fixture' }),
    ).resolves.toMatchObject({
      lease: { backend: 'android-instance', deviceKey: `android:mobile:${serial}` },
    });
    const daemon = JSON.parse(readFileSync(join(stateDir, 'daemon.json'), 'utf8'));
    const rpc = async (params: object) => {
      const response = await fetch(`http://127.0.0.1:${daemon.httpPort}/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent_device.command', params }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.json() as Promise<Record<string, unknown>>;
    };
    const foreign = serial === 'emulator-5554' ? 'emulator-5556' : 'emulator-5554';
    for (const params of [
      { command: 'open', positionals: ['dev.fixture'], flags: { platform: 'android', serial: foreign } },
      { command: 'install', positionals: ['/tmp/never-install.apk'], flags: { platform: 'android', serial } },
      { command: 'record', flags: { platform: 'android', serial } },
      { command: 'logs', flags: { platform: 'android', serial } },
      { command: 'close', flags: { platform: 'android', serial, shutdown: true } },
      {
        command: 'batch',
        flags: {
          platform: 'android',
          serial,
          batchSteps: [
            { command: 'open', positionals: ['dev.fixture'], flags: { serial: foreign, platform: 'android' } },
          ],
        },
      },
    ]) {
      const answer = await rpc({ session: 'compat', ...params });
      expect(JSON.stringify(answer)).toContain('DAEMON_POLICY_DENIED');
    }
    const inventory = await rpc({ command: 'devices', flags: { platform: 'android' } });
    expect(inventory).not.toHaveProperty('error');
    expect(JSON.stringify(inventory)).toContain(serial);
    expect(JSON.stringify(inventory)).not.toMatch(
      new RegExp(`emulator-(?!${serial.slice('emulator-'.length)}\\b)[0-9]+`),
    );
  } finally {
    try {
      await driver.stop();
    } finally {
      delete process.env.STIM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  }
}, 60_000);
