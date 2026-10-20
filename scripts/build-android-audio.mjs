import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('Set ANDROID_HOME or ANDROID_SDK_ROOT to rebuild the bundled Android audio helper.');
const library = join(sdk, 'platforms/android-34/android.jar');
const d8 = join(sdk, 'build-tools/35.0.1/lib/d8.jar');
const scratch = mkdtempSync(join(tmpdir(), 'stim-android-audio-'));
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });
try {
  const classes = join(scratch, 'classes');
  const dex = join(scratch, 'dex');
  mkdirSync(classes);
  mkdirSync(dex);
  run('javac', [
    '-source',
    '8',
    '-target',
    '8',
    '-g:none',
    '-encoding',
    'UTF-8',
    '-bootclasspath',
    library,
    '-d',
    classes,
    join(root, 'packages/stim-cli/shim/android-audio/Main.java'),
  ]);
  run('java', [
    '-cp',
    d8,
    'com.android.tools.r8.D8',
    '--lib',
    library,
    '--min-api',
    '21',
    '--output',
    dex,
    join(classes, 'dev/stim/audio/Main.class'),
  ]);
  const artifact = join(scratch, 'android-audio.jar');
  run('jar', [
    '--create',
    '--no-manifest',
    '--date=1980-01-01T00:00:02Z',
    '--file',
    artifact,
    '-C',
    dex,
    'classes.dex',
  ]);
  copyFileSync(artifact, join(root, 'packages/stim-cli/shim/android-audio.jar'));
  const desktop = join(root, 'apps/desktop/Sources/EmulatorFrames/Resources/android-audio.b64');
  mkdirSync(dirname(desktop), { recursive: true });
  writeFileSync(desktop, readFileSync(artifact).toString('base64') + '\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
