import { createHash } from 'node:crypto';
import {
  createReadStream,
  copyFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, posix, relative, isAbsolute } from 'node:path';
import {
  assertHostedDeviceLedger,
  hostedAppArea,
  readHostedApp,
  readHostedDevice,
  type HostedIosDevice,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { installIosApp, iosAppProcess, launchIosApp } from '../engine/app-install.ts';

function inside(root: string, path: string): boolean {
  const diff = relative(root, path);
  return (
    diff !== '' &&
    diff !== '..' &&
    !diff.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(diff)
  );
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function version(value: string): number[] {
  if (!/^\d+(?:\.\d+){0,2}$/.test(value)) throw new Error('The app or simulator OS version is unknown.');
  return value.split('.').map(Number);
}

function newer(value: string, supported: string): boolean {
  const required = version(value);
  const installed = version(supported);
  for (let index = 0; index < 3; index++) {
    const difference = (required[index] ?? 0) - (installed[index] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

/** Materializes only verified manifest content inside the server-selected attempt, then drives its exact device. */
export async function installHostedApp(
  home: string,
  session: string,
  attempt: string,
  device: HostedIosDevice,
): Promise<true | 'unverified'> {
  const record = readHostedApp(session, attempt, home);
  const area = hostedAppArea(session, attempt, home);
  const app = join(area, 'App.app');
  if (record.state !== 'installing') throw new Error('This app attempt has not been admitted for installation.');
  const manifest = join(area, 'blobs', record.manifest.sha256);
  if (lstatSync(manifest).size !== record.manifest.size || (await digest(manifest)) !== record.manifest.sha256)
    throw new Error('The hosted app manifest differs from its digest.');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { mode: 0o700 });
  for (const file of record.files) {
    const blob = join(area, 'blobs', file.sha256);
    const stat = lstatSync(blob);
    if (!stat.isFile() || stat.size !== file.size || (await digest(blob)) !== file.sha256)
      throw new Error(`App content is incomplete or differs from its digest: ${file.path}`);
    if (file.kind === 'link') continue;
    const target = join(app, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(blob, target);
    chmodSync(target, file.kind === 'exec' ? 0o755 : 0o644);
  }
  for (const file of record.files.filter((each) => each.kind === 'link')) {
    const bytes = readFileSync(join(area, 'blobs', file.sha256));
    const target = bytes.toString('utf8');
    const destination = posix.normalize(posix.join(posix.dirname(file.path), target));
    if (
      !target ||
      !Buffer.from(target).equals(bytes) ||
      /[\\\0\r\n]/.test(target) ||
      posix.isAbsolute(target) ||
      destination === '.' ||
      destination === '..' ||
      destination.startsWith('../') ||
      file.path.startsWith(`${destination}/`)
    )
      throw new Error(`The app link escapes its bundle or forms an ancestor cycle: ${file.path}`);
    const link = join(app, file.path);
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
    symlinkSync(target, link);
  }
  const root = realpathSync(app);
  for (const file of record.files) {
    const path = realpathSync(join(app, file.path));
    if (!inside(root, path)) throw new Error(`The app entry resolves outside its bundle: ${file.path}`);
    if (file.kind !== 'link' && (await digest(path)) !== file.sha256)
      throw new Error('App entries alias different content.');
  }
  const exec = getExecutor();
  const plist = (key: string) =>
    exec.runFile('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Info.plist')], {
      timeoutMs: 10000,
      killSignal: 'SIGKILL',
    });
  if (plist('CFBundleIdentifier') !== record.bundleId)
    throw new Error('The app bundle identity differs from the offered identity.');
  if (plist('DTPlatformName') !== 'iphonesimulator' || !plist('CFBundleSupportedPlatforms').includes('iPhoneSimulator'))
    throw new Error('The app is not an iOS simulator bundle.');
  const executable = plist('CFBundleExecutable');
  if (!executable || /[\\/\0\r\n]/.test(executable) || executable === '.' || executable === '..')
    throw new Error('The app executable is not a bundle-root file.');
  const binary = realpathSync(join(app, executable));
  if (!inside(root, binary)) throw new Error('The app executable resolves outside its bundle.');
  const architectures = exec
    .runFile('xcrun', ['lipo', '-archs', binary], { timeoutMs: 10000, killSignal: 'SIGKILL' })
    .split(/\s+/);
  if (!architectures.includes(device.architecture))
    throw new Error('The app has no executable slice for the hosted simulator architecture.');
  const build = exec.runFile('xcrun', ['vtool', '-arch', device.architecture, '-show-build', binary], {
    timeoutMs: 10000,
    killSignal: 'SIGKILL',
  });
  const minimum = /^\s*minos\s+(\S+)\s*$/m.exec(build)?.[1];
  if (
    !/^\s*platform\s+IOSSIMULATOR\s*$/m.test(build) ||
    !minimum ||
    newer(minimum, device.runtime) ||
    newer(plist('MinimumOSVersion'), device.runtime)
  )
    throw new Error('The executable platform or minimum OS is incompatible with the hosted simulator.');
  assertHostedDeviceLedger(home, device.udid);
  if (readHostedDevice(home).udid !== device.udid) throw new Error('The hosted device identity changed.');
  const installed = installIosApp({
    udid: device.udid,
    appPath: app,
    bundleId: record.bundleId,
    proveInstalled: false,
  });
  if (!installed.ok) throw new Error(installed.reason ?? 'Hosted app installation was not established.');
  assertHostedDeviceLedger(home, device.udid);
  if (readHostedDevice(home).udid !== device.udid) throw new Error('The hosted device identity changed.');
  const launched = launchIosApp({ udid: device.udid, bundleId: record.bundleId, metroPort: null });
  if (!launched.ok) throw new Error(launched.reason ?? 'Hosted app launch was not established.');
  if (record.mode === 'development') return 'unverified';
  for (let tries = 0; tries < 10; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (iosAppProcess(device.udid, record.bundleId)) return true;
  }
  return 'unverified';
}
