import { writeFileSync } from 'node:fs';

const controller = new AbortController();
let loaded = false;
let acknowledge: (() => void) | undefined;
const stop = () => {
  controller.abort(new Error('Fingerprint evaluation was cancelled.'));
  if (loaded) return;
  try {
    acknowledge?.();
  } catch {}
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
let text = '';
for await (const chunk of process.stdin) text += String(chunk);
const input = JSON.parse(text);
acknowledge = () =>
  writeFileSync(input.ownership.acknowledgement, JSON.stringify({ nonce: input.ownership.nonce, settled: true }), {
    mode: 0o600,
  });
const { runPrecomputeChild } = await import('../src/fingerprint/precompute-child.ts');
loaded = true;
const output = await runPrecomputeChild(input, controller, process.env);
if (output !== undefined) process.stdout.write(output);
process.off('SIGTERM', stop);
process.off('SIGINT', stop);
