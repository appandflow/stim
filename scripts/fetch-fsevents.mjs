import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pin = JSON.parse(
  readFileSync(new URL('../packages/stim-cli/native/fsevents-release.json', import.meta.url), 'utf8'),
);
const target = fileURLToPath(new URL('../packages/stim-cli/native/darwin/stim-fsevents', import.meta.url));
const url = `https://github.com/appandflow/stim/releases/download/fsevents-v${pin.version}/stim-fsevents-${pin.version}.zip`;
const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`FSEvents helper download failed: HTTP ${response.status}`);
const zip = Buffer.from(await response.arrayBuffer());
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (digest(zip) !== pin.zipSha256) throw new Error('FSEvents release zip does not match its pinned digest');
const scratch = mkdtempSync(join(tmpdir(), 'stim-fsevents-download-'));
try {
  const archive = join(scratch, 'helper.zip');
  writeFileSync(archive, zip);
  const binary = execFileSync('unzip', ['-p', archive, 'stim-fsevents']);
  if (digest(binary) !== pin.binarySha256) throw new Error('FSEvents binary does not match its pinned digest');
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, binary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(`FSEvents helper ${pin.version}: verified ${pin.binarySha256}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
