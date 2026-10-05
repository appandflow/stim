import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJsonObject } from '@stim-cli/core/state';
import { ServiceError } from './service-plist.ts';

const FLAVORS = {
  release: { name: 'Stim Host', bundleId: 'dev.stim.host' },
  dev: { name: 'Stim Host Dev', bundleId: 'dev.stim.host.dev' },
};
const SOURCES = fileURLToPath(new URL('./stim-host/', import.meta.url));

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new ServiceError(`${file} ${args[0]} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

export async function installHostApp(): Promise<{
  app: string;
  executable: string;
  name: string;
  bundleId: string;
  replaced: boolean;
  adHoc: boolean;
}> {
  const flavor = FLAVORS.dev;
  const applications = join(homedir(), 'Applications');
  const app = join(applications, `${flavor.name}.app`);
  const executable = join(app, 'Contents', 'MacOS', 'stim-host');
  try {
    await run('/usr/bin/xcrun', ['--find', 'clang'], 5000);
  } catch {
    throw new ServiceError(
      'Stim Host Dev needs Xcode Command Line Tools (xcrun clang). Install them with `xcode-select --install`, then run `stim-server service install` again.',
    );
  }
  mkdirSync(applications, { recursive: true });
  const temporary = mkdtempSync(join(applications, `.${flavor.name}.app.${process.pid}.tmp-`));
  const candidate = join(temporary, `${flavor.name}.app`);
  const contents = join(candidate, 'Contents');
  const binary = join(contents, 'MacOS', 'stim-host');
  const info = join(contents, 'Info.plist');
  let cleanup = true;
  try {
    mkdirSync(join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
    writeFileSync(
      info,
      readFileSync(join(SOURCES, 'Info.plist'), 'utf8')
        .replaceAll(FLAVORS.release.bundleId, flavor.bundleId)
        .replaceAll(FLAVORS.release.name, flavor.name),
    );
    // Apple's linker embeds the output filename in its ad hoc signature; keep it stable across builds.
    await run(
      '/usr/bin/xcrun',
      [
        'clang',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-O2',
        '-arch',
        'arm64',
        '-arch',
        'x86_64',
        '-mmacosx-version-min=14.0',
        '-framework',
        'ApplicationServices',
        '-framework',
        'CoreGraphics',
        '-o',
        binary,
        join(SOURCES, 'stim-host.c'),
      ],
      180_000,
    );
    await run('/usr/bin/codesign', ['--force', '--sign', '-', candidate], 30_000);
    const installedInfo = join(app, 'Contents', 'Info.plist');
    if (
      existsSync(executable) &&
      existsSync(installedInfo) &&
      readFileSync(binary).equals(readFileSync(executable)) &&
      readFileSync(info).equals(readFileSync(installedInfo))
    ) {
      return { app, executable, ...flavor, replaced: false, adHoc: true };
    }
    const old = join(temporary, 'previous.app');
    const hadApp = existsSync(app);
    if (hadApp) renameSync(app, old);
    try {
      renameSync(candidate, app);
    } catch (error) {
      if (hadApp) {
        try {
          renameSync(old, app);
        } catch {
          cleanup = false;
          throw new ServiceError(
            `Could not replace ${app} or restore it. The previous bundle is kept at ${old}: ${(error as Error).message}`,
          );
        }
      }
      throw error;
    }
    return { app, executable, ...flavor, replaced: true, adHoc: true };
  } finally {
    if (cleanup) rmSync(temporary, { recursive: true, force: true });
  }
}

export async function readHostPermissions(executable: string): Promise<{
  screenRecording: boolean;
  accessibility: boolean;
} | null> {
  try {
    const value: unknown = JSON.parse(await run(executable, ['permissions'], 5000));
    if (!isJsonObject(value) || typeof value.screenRecording !== 'boolean' || typeof value.accessibility !== 'boolean')
      return null;
    return { screenRecording: value.screenRecording, accessibility: value.accessibility };
  } catch {
    return null;
  }
}

export async function requestHostPermissions(appPath: string): Promise<void> {
  await run('/usr/bin/open', ['-n', '-g', appPath, '--args', 'request-permissions'], 5000);
}

export function permissionPanes(major: number): { screen: string; control: string } {
  return {
    screen: major >= 15 ? 'Screen & System Audio Recording' : 'Screen Recording',
    control: major >= 27 ? 'Device Control and Data Access' : 'Accessibility',
  };
}

export async function hostPermissionPanes(): Promise<ReturnType<typeof permissionPanes>> {
  return permissionPanes(Number((await run('/usr/bin/sw_vers', ['-productVersion'], 5000)).trim().split('.')[0]));
}
