import { hostedAppAttempt, hostedMacosAppSlot, isJsonObject, parseHostedOfferRequest } from '@stim-cli/core/state';
import { collectHostedAndroidLogs } from './android-logs.ts';
import { collectHostedIosLogs } from './ios-logs.ts';
import { runHostedDevice } from './worker.ts';
import { runHostedAndroidDevice } from './android.ts';
import { runHostedMacosApp } from './macos.ts';
import { inspectHostedDevice } from './offer.ts';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += (chunk as Buffer).length;
    if (bytes > 8192) throw new Error('Hosted worker request is too large.');
    chunks.push(chunk as Buffer);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isJsonObject(input) || !['prepare', 'stop', 'install', 'offer', 'logs', 'reverse'].includes(String(input.mode)))
    throw new Error('Invalid hosted worker request.');
  if (input.mode === 'offer') {
    const request = parseHostedOfferRequest(input);
    if (!request) throw new Error('Invalid hosted offer selectors.');
    process.stdout.write(`${JSON.stringify(inspectHostedDevice(request))}\n`);
    return;
  }
  if (process.platform !== 'darwin') {
    process.stdout.write(
      `${JSON.stringify({ state: input.mode === 'prepare' ? 'stopped' : 'unknown', device: null, notice: 'Hosted device sessions require a Mac.' })}\n`,
    );
    return;
  }
  if (
    (input.mode === 'install' || input.mode === 'logs' || input.mode === 'reverse') &&
    (typeof input.session !== 'string' || !/^[a-f0-9-]{36}$/.test(input.session) || !hostedAppAttempt(input.attempt))
  )
    throw new Error('Invalid hosted app request.');
  for (const port of [input.metroPort, input.clientMetroPort]) {
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error('Invalid hosted Metro port.');
  }
  if (input.mode === 'reverse' && input.platform !== 'android') throw new Error('Metro reverse requires Android.');
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
    const more = (input.platform === 'android' ? collectHostedAndroidLogs : collectHostedIosLogs)(
      process.env.STIM_HOME,
      input.session as string,
      input.attempt as string,
      input.since,
      input.final === true,
    );
    process.stdout.write(`${JSON.stringify({ more })}\n`);
    return;
  }
  const result =
    input.platform === 'macos'
      ? await runHostedMacosApp(
          input.mode as 'prepare' | 'stop' | 'install',
          { session: typeof input.session === 'string' ? input.session : '', appSlot: input.appSlot as number },
          input.mode === 'install' ? { attempt: input.attempt as string } : undefined,
        )
      : input.platform === 'android'
        ? await runHostedAndroidDevice(
            input.mode as 'prepare' | 'stop' | 'install' | 'reverse',
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
          )
        : await runHostedDevice(
            input.mode as 'prepare' | 'stop' | 'install',
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
