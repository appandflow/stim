import { S3Client } from '@aws-sdk/client-s3';

process.once('message', async (input: { profile?: string; region: string }) => {
  const client = new S3Client({ ...input, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const credentials = await client.config.credentials();
    process.send?.(credentials, () => process.exit(0));
  } catch {
    process.exitCode = 1;
    process.disconnect?.();
  } finally {
    client.destroy();
  }
});
