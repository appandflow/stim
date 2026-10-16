import { S3Client } from '@aws-sdk/client-s3';
import type { ScopedClientMessage } from './credentials.ts';

process.once('message', async (input: { profile?: string; region: string; endpoint?: string }) => {
  const client = new S3Client({ ...input, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const config = client.config;
    const credentials = await config.credentials();
    const endpoint = input.endpoint ?? (await config.serviceConfiguredEndpoint?.());
    const message: ScopedClientMessage = {
      credentials: { ...credentials, expiration: credentials.expiration?.toISOString() },
      requestConfig: {
        ...(endpoint === undefined ? {} : { endpoint }),
        disableClockSkewCorrection: await config.disableClockSkewCorrection(),
        useFipsEndpoint: await config.useFipsEndpoint(),
        useDualstackEndpoint: await config.useDualstackEndpoint(),
        useArnRegion: typeof config.useArnRegion === 'function' ? await config.useArnRegion() : config.useArnRegion,
        disableS3ExpressSessionAuth:
          typeof config.disableS3ExpressSessionAuth === 'function'
            ? await config.disableS3ExpressSessionAuth()
            : config.disableS3ExpressSessionAuth,
        authSchemePreference:
          typeof config.authSchemePreference === 'function'
            ? await config.authSchemePreference()
            : config.authSchemePreference,
        sigv4aSigningRegionSet:
          typeof config.sigv4aSigningRegionSet === 'function'
            ? await config.sigv4aSigningRegionSet()
            : config.sigv4aSigningRegionSet,
        maxAttempts: typeof config.maxAttempts === 'function' ? await config.maxAttempts() : config.maxAttempts,
        retryMode: typeof config.retryMode === 'function' ? await config.retryMode() : config.retryMode,
        defaultsMode: typeof config.defaultsMode === 'function' ? await config.defaultsMode() : config.defaultsMode,
        userAgentAppId:
          typeof config.userAgentAppId === 'function' ? await config.userAgentAppId() : config.userAgentAppId,
      },
    };
    process.send?.(message, () => process.exit(0));
  } catch {
    process.exitCode = 1;
    process.disconnect?.();
  } finally {
    client.destroy();
  }
});
