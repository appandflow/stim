import { assertHostedDeviceLedger, readHostedApp, readHostedDevice } from '@stim-cli/core/state';
import { androidAppProcess, iosAppProcess, type AppProcessProbe } from '../engine/app-install.ts';
import { assertHostedAndroidSerial, hostedAndroidExecutor } from './android-app.ts';

export async function hostedAppState(
  home: string,
  session: string,
  attempt: string,
  platform: 'ios' | 'android',
): Promise<{ state: AppProcessProbe['state'] }> {
  const app = readHostedApp(session, attempt, home);
  if (app.state !== 'installed') throw new Error('App state requires an installed hosted app attempt.');
  if (platform === 'android') {
    const device = readHostedDevice(home, 'android');
    await assertHostedAndroidSerial(home, device);
    const { state } = await androidAppProcess(device.serial, app.bundleId, { exec: hostedAndroidExecutor() });
    return { state };
  }
  const device = readHostedDevice(home);
  assertHostedDeviceLedger(home, device.udid);
  const { state } = await iosAppProcess(device.udid, app.bundleId);
  return { state };
}
