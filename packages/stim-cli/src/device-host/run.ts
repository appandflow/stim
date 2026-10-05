import { hostedAppAttempt, hostedMacosAppSlot, isJsonObject, parseHostedOfferRequest } from '@stim-cli/core/state';
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
  if (!isJsonObject(input) || !['prepare', 'stop', 'install', 'offer'].includes(String(input.mode)))
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
    input.mode === 'install' &&
    (typeof input.session !== 'string' || !/^[a-f0-9-]{36}$/.test(input.session) || !hostedAppAttempt(input.attempt))
  )
    throw new Error('Invalid hosted app request.');
  if (
    input.metroPort !== undefined &&
    (typeof input.metroPort !== 'number' ||
      !Number.isInteger(input.metroPort) ||
      input.metroPort < 1 ||
      input.metroPort > 65535)
  )
    throw new Error('Invalid hosted Metro port.');
  if (input.platform === 'macos' && !hostedMacosAppSlot(input.appSlot))
    throw new Error('Invalid hosted macOS app slot.');
  const result =
    input.platform === 'macos'
      ? await runHostedMacosApp(
          input.mode as 'prepare' | 'stop' | 'install',
          { session: typeof input.session === 'string' ? input.session : '', appSlot: input.appSlot as number },
          input.mode === 'install' ? { attempt: input.attempt as string } : undefined,
        )
      : input.platform === 'android'
        ? await runHostedAndroidDevice(
            input.mode as 'prepare' | 'stop' | 'install',
            {
              session: typeof input.session === 'string' ? input.session : '',
              consolePort: input.consolePort,
              ...(typeof input.systemImage === 'string' ? { systemImage: input.systemImage } : {}),
              ...(typeof input.deviceProfile === 'string' ? { deviceProfile: input.deviceProfile } : {}),
            },
            input.mode === 'install' ? { attempt: input.attempt as string } : undefined,
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
