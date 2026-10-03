import { isJsonObject } from '@stim-cli/core/state';
import { runHostedDevice } from './worker.ts';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += (chunk as Buffer).length;
    if (bytes > 8192) throw new Error('Hosted worker request is too large.');
    chunks.push(chunk as Buffer);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isJsonObject(input) || !['prepare', 'stop'].includes(String(input.mode)))
    throw new Error('Invalid hosted worker request.');
  if (process.platform !== 'darwin') {
    process.stdout.write(
      `${JSON.stringify({ state: input.mode === 'prepare' ? 'stopped' : 'unknown', device: null, notice: 'Hosted iOS sessions require a Mac.' })}\n`,
    );
    return;
  }
  const result = await runHostedDevice(input.mode as 'prepare' | 'stop', {
    ...(typeof input.deviceType === 'string' ? { deviceType: input.deviceType } : {}),
    ...(typeof input.runtime === 'string' ? { runtime: input.runtime } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(`${String((error as Error).message ?? error)}\n`);
  process.exitCode = 1;
});
