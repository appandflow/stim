import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const pin = JSON.parse(
  readFileSync(new URL('../packages/stim-cli/native/fsevents-release.json', import.meta.url), 'utf8'),
);
const entry = 'package/native/darwin/stim-fsevents';
const scratch = mkdtempSync(join(tmpdir(), 'stim-fsevents-package-'));
try {
  execFileSync('tar', ['-xzpf', resolve(process.argv[2]), '-C', scratch, entry]);
  const helper = join(scratch, entry);
  const mode = statSync(helper).mode & 0o777;
  if (mode !== 0o755) throw new Error(`Packed FSEvents helper mode is ${mode.toString(8)}, expected 755`);
  const digest = createHash('sha256').update(readFileSync(helper)).digest('hex');
  if (digest !== pin.binarySha256) throw new Error('Packed FSEvents helper does not match its pinned digest');
  console.log(`Packed FSEvents helper ${pin.version}: mode 755, verified ${digest}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
