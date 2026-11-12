import { ensureIosRuntime } from '../devices/ios-runtime.ts';
import {
  hostedAppAttempt,
  hostedMacosAppSlot,
  isJsonObject,
  isTcpPort,
  MAX_REVERSE_PORTS,
  parseHostedOfferRequest,
} from '@stim-cli/core/state';
import { collectHostedAndroidLogs } from './android-logs.ts';
import { collectHostedIosLogs } from './ios-logs.ts';
import { runHostedDevice } from './worker.ts';
import { hostedAppState } from './app-state.ts';
import { runHostedAndroidDevice } from './android.ts';
import type { HostedAndroidReverses } from './android-app.ts';
import { runHostedMacosApp } from './macos.ts';
import { inspectHostedDevice } from './offer.ts';
import { androidImageInstallPolicy, ensureSystemImage } from '../devices/android-image.ts';
import { loadConfig } from '../workspace/config.ts';
import { countLiveOwnedDevicesByPlatform, type DeviceCountExclusion } from '../engine/device-capacity.ts';

function expectedMacosApp(
  input: Record<string, unknown>,
): { pid: number; token: string; launchId: string } | undefined {
  if ((input.mode === 'stop-app' || input.mode === 'stop-current') && input.platform !== 'macos')
    throw new Error('App stop requires macOS.');
  if (input.mode !== 'stop-current') return undefined;
  const app = input.expectedApp;
  if (
    !isJsonObject(app) ||
    typeof app.pid !== 'number' ||
    !Number.isSafeInteger(app.pid) ||
    app.pid <= 0 ||
    typeof app.token !== 'string' ||
    typeof app.launchId !== 'string'
  )
    throw new Error('Invalid hosted macOS app identity.');
  return { pid: app.pid, token: app.token, launchId: app.launchId };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += (chunk as Buffer).length;
    if (bytes > 8192) throw new Error('Hosted worker request is too large.');
    chunks.push(chunk as Buffer);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (
    !isJsonObject(input) ||
    ![
      'prepare',
      'stop',
      'stop-app',
      'stop-current',
      'install',
      'app-state',
      'offer',
      'runtime',
      'count',
      'image',
      'logs',
      'reverse',
      'reverse-ports',
      'park',
      'inspect',
      'adopt',
      'resume',
    ].includes(String(input.mode))
  )
    throw new Error('Invalid hosted worker request.');
  let exclude: DeviceCountExclusion[] | undefined;
  if (input.exclude !== undefined) {
    if (
      !Array.isArray(input.exclude) ||
      input.exclude.some(
        (device) =>
          !isJsonObject(device) ||
          (device.platform !== 'ios' && device.platform !== 'android') ||
          (device.key !== undefined && typeof device.key !== 'string'),
      )
    )
      throw new Error('Invalid hosted device exclusions.');
    exclude = input.exclude as DeviceCountExclusion[];
  }
  if (input.mode === 'runtime') {
    if (typeof input.runtime !== 'string' || !/^(?:iOS )?\d+\.\d+(?:\.\d+)?$/.test(input.runtime))
      throw new Error('Invalid iOS runtime version.');
    const result = await ensureIosRuntime({ requested: input.runtime, workerProcessGroup: true, note: () => {} });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (input.mode === 'count') {
    process.stdout.write(`${JSON.stringify(countLiveOwnedDevicesByPlatform({}, { exclude }))}\n`);
    return;
  }
  if (input.mode === 'offer') {
    const request = parseHostedOfferRequest(input);
    if (!request) throw new Error('Invalid hosted offer selectors.');
    process.stdout.write(`${JSON.stringify(await inspectHostedDevice(request, exclude ? { exclude } : undefined))}\n`);
    return;
  }
  if (input.mode === 'image') {
    if (input.systemImage !== undefined && typeof input.systemImage !== 'string')
      throw new Error('Invalid hosted image request.');
    const image = await ensureSystemImage({
      requested: input.systemImage ?? null,
      policy: androidImageInstallPolicy(loadConfig()),
      env: process.env,
      note: () => {},
    });
    process.stdout.write(
      `${JSON.stringify(image.ok ? { state: 'ready' } : { state: 'refused', notice: `${image.message} ${image.remedy}` })}\n`,
    );
    return;
  }
  if (process.platform !== 'darwin') {
    process.stdout.write(
      `${JSON.stringify({ state: input.mode === 'prepare' ? 'stopped' : 'unknown', device: null, notice: 'Hosted device sessions require a Mac.' })}\n`,
    );
    return;
  }
  if (['install', 'stop-app', 'stop-current', 'app-state', 'logs', 'reverse'].includes(String(input.mode))) {
    if (typeof input.session !== 'string' || !/^[a-f0-9-]{36}$/.test(input.session) || !hostedAppAttempt(input.attempt))
      throw new Error('Invalid hosted app request.');
    if (input.mode === 'app-state') {
      if ((input.platform !== 'ios' && input.platform !== 'android') || !process.env.STIM_HOME)
        throw new Error('App state requires a hosted iOS or Android session.');
      const result = await hostedAppState(process.env.STIM_HOME, input.session, input.attempt, input.platform);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
  }
  for (const port of [input.metroPort, input.clientMetroPort]) {
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error('Invalid hosted Metro port.');
  }
  const expectedApp = expectedMacosApp(input);
  if (input.mode === 'reverse' && input.platform !== 'android') throw new Error('Metro reverse requires Android.');
  let reverses: HostedAndroidReverses | undefined;
  if (input.mode === 'reverse-ports') {
    const listed: unknown[] = Array.isArray(input.reverses) ? input.reverses : [];
    const add = listed.flatMap((each) =>
      isJsonObject(each) && isTcpPort(each.devicePort) && isTcpPort(each.bridgePort)
        ? [{ devicePort: each.devicePort, bridgePort: each.bridgePort }]
        : [],
    );
    const dropped: unknown[] = Array.isArray(input.removed) ? input.removed : [];
    const removed = dropped.filter(isTcpPort);
    if (
      input.platform !== 'android' ||
      !Array.isArray(input.reverses) ||
      !Array.isArray(input.removed) ||
      add.length !== listed.length ||
      removed.length !== dropped.length ||
      add.length > MAX_REVERSE_PORTS ||
      removed.length > MAX_REVERSE_PORTS
    )
      throw new Error('Invalid hosted Android reverse ports request.');
    reverses = { add, removed };
  }
  if (input.platform === 'macos' && ['park', 'inspect', 'adopt', 'resume'].includes(String(input.mode)))
    throw new Error('Hosted parking and resuming require iOS or Android.');
  if (input.platform === 'macos' && !hostedMacosAppSlot(input.appSlot))
    throw new Error('Invalid hosted macOS app slot.');
  if (input.mode === 'logs') {
    if (
      (input.platform !== 'ios' && input.platform !== 'android') ||
      !process.env.STIM_HOME ||
      typeof input.since !== 'number' ||
      !Number.isFinite(input.since)
    )
      throw new Error('Invalid hosted native log request.');
    const session = input.session as string;
    const attempt = input.attempt as string;
    const more =
      input.platform === 'ios'
        ? await collectHostedIosLogs(
            process.env.STIM_HOME,
            session,
            attempt,
            input.since,
            process.env,
            input.final === true,
          )
        : await collectHostedAndroidLogs(process.env.STIM_HOME, session, attempt, input.since, input.final === true);
    process.stdout.write(`${JSON.stringify({ more })}\n`);
    return;
  }
  const result =
    input.platform === 'macos'
      ? await runHostedMacosApp(
          input.mode as 'prepare' | 'stop' | 'stop-app' | 'stop-current' | 'install',
          {
            session: typeof input.session === 'string' ? input.session : '',
            appSlot: input.appSlot as number,
            ...(expectedApp ? { expectedApp } : {}),
          },
          input.mode === 'install' || input.mode === 'stop-app' ? { attempt: input.attempt as string } : undefined,
        )
      : input.platform === 'android'
        ? await runHostedAndroidDevice(
            input.mode as
              | 'prepare'
              | 'stop'
              | 'install'
              | 'reverse'
              | 'reverse-ports'
              | 'park'
              | 'inspect'
              | 'adopt'
              | 'resume',
            {
              session: typeof input.session === 'string' ? input.session : '',
              consolePort: input.consolePort,
              ...(typeof input.systemImage === 'string' ? { systemImage: input.systemImage } : {}),
              ...(typeof input.deviceProfile === 'string' ? { deviceProfile: input.deviceProfile } : {}),
            },
            input.mode === 'install' || input.mode === 'reverse'
              ? {
                  attempt: input.attempt as string,
                  metroPort: input.metroPort as number | undefined,
                  clientMetroPort: input.clientMetroPort as number | undefined,
                }
              : undefined,
            reverses,
          )
        : await runHostedDevice(
            input.mode as 'prepare' | 'stop' | 'install' | 'park' | 'inspect' | 'adopt' | 'resume',
            {
              ...(typeof input.deviceType === 'string' ? { deviceType: input.deviceType } : {}),
              ...(typeof input.runtime === 'string' ? { runtime: input.runtime } : {}),
            },
            input.mode === 'install'
              ? {
                  session: input.session as string,
                  attempt: input.attempt as string,
                  ...(typeof input.metroPort === 'number' ? { metroPort: input.metroPort } : {}),
                }
              : undefined,
          );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(`${String((error as Error).message ?? error)}\n`);
  process.exitCode = 1;
});
