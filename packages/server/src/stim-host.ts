import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

export interface HostApp {
  app: string;
  executable: string;
  name: string;
  bundleId: string;
  replaced: boolean;
  adHoc: boolean;
}

const STALE_TEMPORARY = /^\.Stim Host(?: Dev)?\.app\.(\d+)\.tmp-/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function bundleIdOf(app: string): string | null {
  try {
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(
      readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'),
    )![1]!;
  } catch {
    return null;
  }
}

/**
 * The signed Stim Host release `install` downloads, pinned by version and the SHA-256 of its zip, which the
 * host-release workflow prints. While it is null, `install` builds Stim Host Dev on the Mac instead.
 */
const RELEASE: { version: string; sha256: string } | null = null;

/** Developer ID Application certificates of App & Flow's team, the team that signs Stim Desktop. */
const RELEASE_REQUIREMENT =
  'identifier "dev.stim.host" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "R7E8P23K3N"';

async function buildDev(candidate: string, sources: string): Promise<void> {
  try {
    await run('/usr/bin/xcode-select', ['-p'], 5000);
  } catch {
    throw new ServiceError(
      `${FLAVORS.dev.name} is built with Xcode Command Line Tools. Install them with \`xcode-select --install\`, then run \`stim-server service install\` again.`,
    );
  }
  const contents = join(candidate, 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  writeFileSync(
    join(contents, 'Info.plist'),
    readFileSync(join(sources, 'Info.plist'), 'utf8')
      .replaceAll(FLAVORS.release.bundleId, FLAVORS.dev.bundleId)
      .replaceAll(FLAVORS.release.name, FLAVORS.dev.name),
  );
  // ld64 output differs with the output file name, which changes the cdhash an ad hoc grant is keyed to.
  await run(
    '/usr/bin/xcrun',
    [
      'clang',
      '-Wall',
      '-Wextra',
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
      join(contents, 'MacOS', 'stim-host'),
      join(sources, 'stim-host.c'),
    ],
    180_000,
  );
  await run('/usr/bin/codesign', ['--force', '--sign', '-', candidate], 30_000);
}

/**
 * Checks a downloaded release zip against its pinned SHA-256, unpacks it into `dir` and verifies that the bundle is
 * signed by App & Flow's Developer ID. Resolves to the unpacked `Stim Host.app`.
 */
export async function unpackRelease(zip: Buffer, sha256: string, dir: string): Promise<string> {
  const actual = createHash('sha256').update(zip).digest('hex');
  if (actual !== sha256) {
    throw new ServiceError(
      `The downloaded Stim Host has SHA-256 ${actual}, not the pinned ${sha256}; not installing it.`,
    );
  }
  const archive = join(dir, 'StimHost.zip');
  writeFileSync(archive, zip);
  await run('/usr/bin/ditto', ['-x', '-k', archive, dir], 60_000);
  const app = join(dir, `${FLAVORS.release.name}.app`);
  try {
    await run('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${RELEASE_REQUIREMENT}`, app], 30_000);
  } catch (error) {
    throw new ServiceError(
      `The downloaded Stim Host is not signed by App & Flow's Developer ID; not installing it. ${(error as Error).message}`,
    );
  }
  return app;
}

async function downloadRelease(release: { version: string; sha256: string }, dir: string): Promise<string> {
  const url = `https://github.com/appandflow/stim/releases/download/host-v${release.version}/StimHost-${release.version}.zip`;
  let zip: Buffer;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    zip = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new ServiceError(
      `Could not download Stim Host ${release.version} from ${url} (${(error as Error).message}). Check this Mac's connection, then run install again.`,
    );
  }
  return unpackRelease(zip, release.sha256, dir);
}

/**
 * Installs the host app in `~/Applications`: the pinned signed release, or Stim Host Dev built from `sources` while
 * none is pinned. An installed bundle with the same bytes stays untouched, so the grants macOS keyed to its signature
 * still match.
 */
export async function installHostApp(sources: string = SOURCES): Promise<HostApp> {
  const flavor = RELEASE ? FLAVORS.release : FLAVORS.dev;
  const applications = join(homedir(), 'Applications');
  const app = join(applications, `${flavor.name}.app`);
  const executable = join(app, 'Contents', 'MacOS', 'stim-host');
  if (existsSync(app) && bundleIdOf(app) !== flavor.bundleId) {
    throw new ServiceError(
      `${app} is not a ${flavor.name} bundle (${flavor.bundleId}); not replacing it. Move it away, then run install again.`,
    );
  }
  mkdirSync(applications, { recursive: true });
  for (const entry of readdirSync(applications)) {
    const owner = STALE_TEMPORARY.exec(entry)?.[1];
    if (owner && !alive(Number(owner))) rmSync(join(applications, entry), { recursive: true, force: true });
  }
  const temporary = mkdtempSync(join(applications, `.${flavor.name}.app.${process.pid}.tmp-`));
  let cleanup = true;
  try {
    let candidate = join(temporary, `${flavor.name}.app`);
    if (RELEASE) candidate = await downloadRelease(RELEASE, temporary);
    else await buildDev(candidate, sources);
    const result = { app, executable, ...flavor, adHoc: !RELEASE };
    const binary = join(candidate, 'Contents', 'MacOS', 'stim-host');
    const info = join(candidate, 'Contents', 'Info.plist');
    const installedInfo = join(app, 'Contents', 'Info.plist');
    if (
      existsSync(executable) &&
      existsSync(installedInfo) &&
      readFileSync(binary).equals(readFileSync(executable)) &&
      readFileSync(info).equals(readFileSync(installedInfo))
    ) {
      return { ...result, replaced: false };
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
    return { ...result, replaced: true };
  } finally {
    if (cleanup) rmSync(temporary, { recursive: true, force: true });
  }
}

/** The host app a server runs under, from the `STIM_HOST_EXECUTABLE` its launcher set, or undefined. */
export function hostFromExecutable(executable: string | undefined): { executable: string; name: string } | undefined {
  const name = executable && /\/(Stim Host(?: Dev)?)\.app\/Contents\/MacOS\/stim-host$/.exec(executable)?.[1];
  return executable && name ? { executable, name } : undefined;
}

export async function readHostPermissions(executable: string): Promise<{
  screenRecording: boolean;
  accessibility: boolean;
} | null> {
  try {
    const value: unknown = JSON.parse(await run(executable, ['permissions'], 2000));
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
