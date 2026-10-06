import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import {
  assertHostedDeviceLedger,
  hostedMacosAppSlot,
  hostedMacosBundleId,
  isJsonObject,
  readHostedDevice,
  readMacosRecord,
  type HostedMacosChoice,
  type HostedMacosDevice,
  type MacosAppRecord,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readHostMemoryPressure } from '../host-memory.ts';
import { macosProcess, requiredMacosRecord } from '../macos/state.ts';
import { stopMacosAppHeld } from '../macos/stop.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { materializeHostedApp, newer } from './app.ts';
import type { HostedWorkerResult } from './worker.ts';

export function selectHostedMacos(): HostedMacosChoice {
  if (readHostMemoryPressure(getExecutor()) !== 'normal')
    throw new Error('Host memory pressure is unknown or elevated.');
  const macosVersion = getExecutor().runFile('sw_vers', ['-productVersion'], {
    timeoutMs: 10000,
    killSignal: 'SIGKILL',
  });
  if (!/^\d+(\.\d+){0,2}$/.test(macosVersion)) throw new Error('The host macOS version is unknown.');
  return { architecture: process.arch === 'arm64' ? 'arm64' : 'x86_64', macosVersion };
}

function writeRecord(home: string, file: string, value: object): void {
  withDirLock(join(home, 'hosted-device.lock'), () => {
    const temporary = join(home, `${file}.tmp`);
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, join(home, file));
  });
}

function preferenceIdentity(home: string, appSlot: number): string | null {
  const file = join(home, 'hosted-macos-app.json');
  if (!existsSync(file)) return null;
  const stored: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !isJsonObject(stored) ||
    typeof stored.bundleId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,248}$/.test(stored.bundleId) ||
    stored.bundleId.startsWith('com.apple.') ||
    !stored.bundleId.endsWith(`.hosted${appSlot}`)
  )
    throw new Error('The hosted macOS preference identity is malformed.');
  return stored.bundleId;
}

function removePreferences(bundleId: string): void {
  const exec = getExecutor();
  const options = { timeoutMs: 10000, killSignal: 'SIGKILL' as const };
  exec.runFileQuiet('defaults', ['delete', bundleId], options);
  const file = join(homedir(), 'Library', 'Preferences', `${bundleId}.plist`);
  rmSync(file, { force: true });
  if (existsSync(file)) throw new Error('The hosted macOS preferences plist still exists after deletion.');
  try {
    exec.runFile('defaults', ['read', bundleId], options);
  } catch (error) {
    if (/not found|does not exist/i.test((error as Error).message)) return;
    throw error;
  }
  throw new Error('The hosted macOS preference domain is still readable after deletion.');
}

function assertInside(root: string, path: string): void {
  const diff = relative(root, realpathSync(path));
  if (!diff || diff === '..' || diff.startsWith(`..${sep}`) || isAbsolute(diff))
    throw new Error('Hosted macOS app data resolves outside its private area.');
}

function removeAppData(root: string, path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  assertInside(root, path);
  rmSync(path, { recursive: true, force: true });
}

export async function runHostedMacosApp(
  mode: 'prepare' | 'stop' | 'install',
  request: { session: string; appSlot: number },
  app?: { attempt: string },
): Promise<HostedWorkerResult> {
  const home = process.env.STIM_HOME;
  let device: HostedMacosDevice | null = null;
  let recorded = false;
  try {
    if (!home) throw new Error('Hosted workers require their isolated STIM_HOME.');
    if (!hostedMacosAppSlot(request.appSlot)) throw new Error('Hosted macOS workers require a reserved app slot.');
    if (mode === 'prepare') {
      recorded = existsSync(join(home, 'hosted-device.json'));
      if (recorded) throw new Error('Attach or stop the existing hosted macOS session.');
      const selected = { ...selectHostedMacos(), appSlot: request.appSlot };
      assertHostedDeviceLedger(home, `macos-${request.appSlot}`, 'macos');
      writeRecord(home, 'hosted-device.json', selected);
      recorded = true;
      device = selected;
      return { state: 'ready', device };
    }
    device = readHostedDevice(home, 'macos');
    if (device.appSlot !== request.appSlot) throw new Error('The hosted macOS app slot changed.');
    assertHostedDeviceLedger(home, `macos-${device.appSlot}`, 'macos');
    const runRoot = join(realpathSync(home), 'macos-app');
    if (mode === 'stop') {
      if (requiredMacosRecord(runRoot)) await stopMacosAppHeld(runRoot);
      const bundleId = preferenceIdentity(home, device.appSlot);
      if (bundleId) removePreferences(bundleId);
      const area = realpathSync(join(home, '..'));
      assertInside(area, home);
      removeAppData(realpathSync(home), join(home, 'app-home'));
      const apps = join(home, '..', 'apps');
      if (existsSync(apps)) {
        assertInside(area, apps);
        for (const attempt of readdirSync(apps)) {
          const directory = join(apps, attempt);
          assertInside(area, directory);
          removeAppData(area, join(directory, 'App.app'));
          removeAppData(area, join(directory, 'blobs'));
        }
      }
      removeAppData(area, join(home, '..', 'blobs'));
      return { state: 'stopped', device };
    }
    if (!app) throw new Error('Hosted macOS installation needs its admitted app attempt.');
    const { app: bundle, root, record } = await materializeHostedApp(home, request.session, app.attempt);
    const exec = getExecutor();
    const options = { timeoutMs: 10000, killSignal: 'SIGKILL' as const };
    const plistPath = join(bundle, 'Contents', 'Info.plist');
    const plist: unknown = JSON.parse(exec.runFile('plutil', ['-convert', 'json', '-o', '-', plistPath], options));
    if (!isJsonObject(plist) || plist.CFBundleIdentifier !== record.bundleId)
      throw new Error('The app bundle identity differs from the offered identity.');
    const product = plist.CFBundleExecutable;
    if (typeof product !== 'string' || !product || /[\\/\0\r\n]/.test(product) || product === '.' || product === '..')
      throw new Error('The app executable must be a single path component.');
    if (plist.CFBundleURLTypes !== undefined || plist.SUFeedURL !== undefined)
      throw new Error('Hosted macOS apps cannot register shared URL schemes or an update feed.');
    if (
      plist.LSMinimumSystemVersion !== undefined &&
      (typeof plist.LSMinimumSystemVersion !== 'string' || newer(plist.LSMinimumSystemVersion, device.macosVersion))
    )
      throw new Error('The app minimum OS is incompatible with the hosted Mac.');
    const executable = realpathSync(join(bundle, 'Contents', 'MacOS', product));
    const diff = relative(root, executable);
    if (!diff || diff === '..' || diff.startsWith(`..${sep}`) || isAbsolute(diff))
      throw new Error('The app executable resolves outside its bundle.');
    const architectures = exec.runFile('xcrun', ['lipo', '-archs', executable], options).split(/\s+/);
    if (!architectures.includes(device.architecture))
      throw new Error('The app has no executable slice for the hosted Mac architecture.');
    const build = exec.runFile('xcrun', ['vtool', '-arch', device.architecture, '-show-build', executable], options);
    const minimum = /^\s*minos\s+(\S+)\s*$/m.exec(build)?.[1];
    if (!/^\s*platform\s+MACOS\s*$/m.test(build) || !minimum || newer(minimum, device.macosVersion))
      throw new Error('The executable platform or minimum OS is incompatible with the hosted Mac.');
    const bundleId = hostedMacosBundleId(record.bundleId, device.appSlot);
    exec.runFile('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${bundleId}`, plistPath], options);
    const frameworks = join(bundle, 'Contents', 'Frameworks');
    if (existsSync(frameworks)) {
      for (const entry of readdirSync(frameworks)) {
        if (entry.endsWith('.framework'))
          exec.runFile('codesign', ['--force', '--sign', '-', join(frameworks, entry)], options);
      }
    }
    exec.runFile('codesign', ['--force', '--sign', '-', bundle], options);
    if (requiredMacosRecord(runRoot)) await stopMacosAppHeld(runRoot);
    const previousId = preferenceIdentity(home, device.appSlot);
    if (previousId && previousId !== bundleId) removePreferences(previousId);
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    const canonicalRunRoot = realpathSync(runRoot);
    ensureWorkspaceStorage(canonicalRunRoot);
    const launch: MacosAppRecord = {
      product,
      bundle: root,
      bundleId,
      executable,
      arguments: record.arguments ?? [],
      launchId: randomUUID(),
      supervisor: macosProcess(process.pid),
      build: { state: 'ok', startedAt: new Date().toISOString() },
    };
    writeRecord(home, 'hosted-macos-app.json', { bundleId });
    writeWorkspaceState(canonicalRunRoot, { macos: launch });
    const isolated = join(home, 'app-home');
    const temporary = join(isolated, 'tmp');
    mkdirSync(isolated, { recursive: true, mode: 0o700 });
    mkdirSync(temporary, { mode: 0o700, recursive: true });
    const fd = openSync(join(home, 'macos-supervisor.log'), 'a', 0o600);
    let child;
    let spawnError: Error | undefined;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TERM'])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, { STIM_HOME: home, HOME: isolated, CFFIXED_USER_HOME: isolated, TMPDIR: temporary });
    try {
      child = exec.spawn(process.execPath, [spawnEntry('macos-run'), canonicalRunRoot, launch.launchId], {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: canonicalRunRoot,
        env,
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const current = readMacosRecord(canonicalRunRoot);
      if (
        current?.launchId === launch.launchId &&
        current.app &&
        current.supervisor &&
        inspectProcessIdentity(current.app) === 'same' &&
        inspectProcessIdentity(current.supervisor) === 'same'
      )
        return { state: 'installed', device, launched: true, pid: current.app.pid };
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The hosted macOS app did not register. See macos-supervisor.log in the worker home.');
  } catch (error) {
    return {
      state:
        mode === 'prepare' && !recorded && !device && !(home && existsSync(join(home, 'hosted-device.json')))
          ? 'stopped'
          : 'unknown',
      device,
      notice: (error as Error).message,
    };
  }
}
