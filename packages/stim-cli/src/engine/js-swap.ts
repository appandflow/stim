import { ensurePrivateDir, type StimContext } from '@stim-cli/core';
import { makeTemporaryDirectory, removeTemporaryEntry } from '../temporary.ts';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { createLineReader, waitForChild } from '../process-output.ts';
import { runOperationFile } from './operation-exec.ts';
import { bundleInvocation } from './node-cli.ts';
import { spawnDeclared } from './spawn-claims.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { killOnAbort } from '../workspace/git-read.ts';
import { operationState } from './operation-state.ts';
import { cleanLine, expoTelemetryEnv } from '../supervisor/server-expo.ts';
import { HEARTBEAT_INTERVAL_MS, startBuildHeartbeat, tailLines } from './xcode.ts';
import { workspaceDir } from '../workspace/paths.ts';

export const JS_BUNDLE_NAME = 'main.jsbundle';

const LAST_LINES = 5;

export function hermesEnabledFromProperties(text: unknown): boolean {
  if (typeof text !== 'string') return true;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return true;
  }
  if (!data || typeof data !== 'object') return true;
  const raw = (data as { hermesEnabled?: unknown }).hermesEnabled;
  return raw !== 'false' && raw !== false;
}

export function readHermesEnabled(iosDir: string): boolean {
  try {
    return hermesEnabledFromProperties(readFileSync(join(iosDir, 'Podfile.properties.json'), 'utf-8'));
  } catch {
    return true;
  }
}

const ENTRY_CANDIDATES = ['index.js', 'index.ts', 'index.tsx', 'index.jsx'];

export function pickEntryFile(entries: unknown): string {
  const names = new Set((Array.isArray(entries) ? entries : []).filter((e) => typeof e === 'string'));
  return ENTRY_CANDIDATES.find((c) => names.has(c)) ?? 'index.js';
}

export function detectEntryFile(root: string): string {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 'index.js';
  }
  return pickEntryFile(entries);
}

function bundlerInputsKey(root: string, env: NodeJS.ProcessEnv): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(env).toSorted()) {
    if (name.startsWith('EXPO_PUBLIC_') || name === 'EXPO_NO_DOTENV' || name === 'NODE_ENV')
      hash.update(`env\0${name}\0${env[name] ?? ''}\0`);
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root)
      .filter((name) => name.startsWith('.env'))
      .toSorted();
  } catch {}
  for (const name of entries) {
    try {
      hash
        .update(`file\0${name}\0`)
        .update(readFileSync(join(root, name)))
        .update('\0');
    } catch {}
  }
  return hash.digest('hex');
}

/**
 * The TMPDIR for a swap's bundler child: a workspace-private directory that holds Metro's transform cache
 * (`$TMPDIR/metro-cache`). Metro's cache key omits the `EXPO_PUBLIC_*` values babel-preset-expo inlines,
 * and `expo export:embed` ignores `--reset-cache` when `CI` is set (expo/expo#49630), so the directory is
 * emptied whenever those values, the project's `.env*` files, or the `EXPO_NO_DOTENV` and `NODE_ENV` that
 * select which of those files Expo loads differ from the previous swap's.
 */
function swapBundlerTmpdir(root: string, env: NodeJS.ProcessEnv): string {
  const dir = join(workspaceDir(root), 'js-swap-tmp');
  const stamp = join(dir, 'inputs');
  const key = bundlerInputsKey(root, env);
  let previous: string | null = null;
  try {
    previous = readFileSync(stamp, 'utf-8');
  } catch {}
  if (previous !== key) {
    rmSync(dir, { recursive: true, force: true });
    ensurePrivateDir(dir);
    writeFileSync(stamp, key);
  }
  return dir;
}

/** Node's `os.tmpdir()` reads `TMPDIR` on POSIX and `TEMP`, then `TMP`, on Windows. */
export function swapBundlerEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const tmp = swapBundlerTmpdir(root, env);
  return { ...env, ...expoTelemetryEnv(env), FORCE_COLOR: '0', TMPDIR: tmp, TEMP: tmp, TMP: tmp };
}

export function bundleCommand({
  isExpo,
  entryFile,
  bundleOutput,
  assetsDest,
  assetCatalogDest = null,
}: {
  isExpo: boolean;
  entryFile: string;
  bundleOutput: string;
  assetsDest: string;
  assetCatalogDest?: string | null;
}): { file: string; args: string[] } {
  const catalogArgs = assetCatalogDest ? ['--asset-catalog-dest', assetCatalogDest] : [];
  if (isExpo) {
    return {
      file: 'npx',
      args: [
        'expo',
        'export:embed',
        '--platform',
        'ios',
        '--dev',
        'false',
        '--bundle-output',
        bundleOutput,
        '--assets-dest',
        assetsDest,
        ...catalogArgs,
      ],
    };
  }
  return {
    file: 'npx',
    args: [
      'react-native',
      'bundle',
      '--platform',
      'ios',
      '--dev',
      'false',
      '--entry-file',
      entryFile,
      '--bundle-output',
      bundleOutput,
      '--assets-dest',
      assetsDest,
      ...catalogArgs,
    ],
  };
}

const ASSET_CATALOG_BUNDLE = 'RNAssets.bundle';

export type AssetCatalogTarget = { platform: string; minimumDeploymentTarget: string; targetDevices: string[] };

/**
 * Where React Native 0.88+ keeps the app's packager images. With the `RCTUseAssetCatalog` Info.plist
 * key, `react-native-xcode.sh` compiles them with actool into RNAssets.bundle and the native image
 * loader reads only that catalog, so a swap has to rebuild it. Null means loose files under assets/.
 */
export function assetCatalogTarget(infoPlist: unknown): AssetCatalogTarget | null {
  if (!infoPlist || typeof infoPlist !== 'object') return null;
  const plist = infoPlist as Record<string, unknown>;
  const flag = plist.RCTUseAssetCatalog;
  const on =
    flag === true || flag === 1 || (typeof flag === 'string' && ['true', 'yes', '1'].includes(flag.toLowerCase()));
  if (!on) return null;
  const families = Array.isArray(plist.UIDeviceFamily) ? plist.UIDeviceFamily : [1];
  const targetDevices = [...(families.includes(1) ? ['iphone'] : []), ...(families.includes(2) ? ['ipad'] : [])];
  return {
    platform: typeof plist.DTPlatformName === 'string' ? plist.DTPlatformName : 'iphoneos',
    minimumDeploymentTarget: typeof plist.MinimumOSVersion === 'string' ? plist.MinimumOSVersion : '15.1',
    targetDevices: targetDevices.length ? targetDevices : ['iphone'],
  };
}

// plutil -convert json refuses a whole plist that holds <data> or <date>, so read single keys.
// plutil on macOS 15 prints the missing-key error on stdout, not stderr.
async function readPlistKey(
  context: StimContext | undefined,
  e: Executor,
  plist: string,
  key: string,
  format: 'raw' | 'json',
): Promise<string | null> {
  try {
    return await runOperationFile(context, e, 'plutil', ['-extract', key, format, '-o', '-', plist], {
      timeoutMs: 10_000,
    });
  } catch (err) {
    const stdout = typeof err === 'object' && err !== null && 'stdout' in err ? String(err.stdout) : '';
    if (/No value at that key path/.test(`${describe(err)}\n${stdout}`)) return null;
    throw err;
  }
}

async function readAssetCatalogTarget(
  context: StimContext | undefined,
  e: Executor,
  plist: string,
): Promise<AssetCatalogTarget | null> {
  const flag = await readPlistKey(context, e, plist, 'RCTUseAssetCatalog', 'raw');
  if (flag === null) return null;
  const families = await readPlistKey(context, e, plist, 'UIDeviceFamily', 'json');
  return assetCatalogTarget({
    RCTUseAssetCatalog: flag,
    DTPlatformName: await readPlistKey(context, e, plist, 'DTPlatformName', 'raw'),
    MinimumOSVersion: await readPlistKey(context, e, plist, 'MinimumOSVersion', 'raw'),
    UIDeviceFamily: families === null ? undefined : JSON.parse(families),
  });
}

function actoolArgs({ catalog, out, target }: { catalog: string; out: string; target: AssetCatalogTarget }): string[] {
  return [
    'actool',
    catalog,
    '--compile',
    out,
    '--output-format',
    'human-readable-text',
    '--errors',
    '--warnings',
    '--notices',
    '--platform',
    target.platform,
    '--minimum-deployment-target',
    target.minimumDeploymentTarget,
    ...target.targetDevices.flatMap((device) => ['--target-device', device]),
  ];
}

const ASSET_CATALOG_BUNDLE_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>org.reactjs.RNAssets</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>RNAssets</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
</dict>
</plist>
`;

export const UPDATES_MANIFEST_NAME = 'app.manifest';

/**
 * expo-updates launches the update with the newest `commitTime` among those built for the binary's
 * runtime version, and the embedded one is only a row in that race. A swapped copy keeps the id and
 * `commitTime` the cached build wrote, so an update downloaded after that build would launch instead
 * of the injected bundle. A full build writes a fresh id and `commitTime`; this does the same.
 */
function refreshUpdatesManifest(text: string, { id, commitTime }: { id: string; commitTime: number }): string {
  const manifest: unknown = JSON.parse(text);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${UPDATES_MANIFEST_NAME} is not a JSON object`);
  }
  return JSON.stringify({ ...manifest, id, commitTime });
}

export function refreshUpdatesManifestFile(path: string, commitTime: number): void {
  writeFileSync(path, refreshUpdatesManifest(readFileSync(path, 'utf-8'), { id: randomUUID(), commitTime }));
}

const IOS_UPDATES_MANIFESTS = [join('EXUpdates.bundle', UPDATES_MANIFEST_NAME), UPDATES_MANIFEST_NAME];
const IOS_FRAMEWORK_UPDATES_MANIFEST = join(
  'Frameworks',
  'EXUpdates.framework',
  'EXUpdates.bundle',
  UPDATES_MANIFEST_NAME,
);

export function hermescPath(
  root: string,
  iosDir: string,
  { exists = existsSync }: { exists?: (p: string) => boolean } = {},
): string {
  const candidates = [
    join(root, 'node_modules', 'hermes-compiler', 'hermesc', 'osx-bin', 'hermesc'),
    join(iosDir, 'Pods', 'hermes-engine', 'destroot', 'bin', 'hermesc'),
    join(root, 'node_modules', 'react-native', 'sdks', 'hermesc', 'osx-bin', 'hermesc'),
  ];
  return candidates.find(exists) ?? candidates[candidates.length - 1]!;
}

export function hermescArgs({ bundle, out }: { bundle: string; out: string }): string[] {
  return ['-emit-binary', '-out', out, bundle];
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export type JsSwapResult = {
  ok?: boolean;
  appPath?: string;
  tmpDir?: string;
  hermes?: boolean;
  note?: string;
  durationMs?: number;
  failed?: boolean;
  step?: string;
  reason?: string;
  lastLines?: string[];
};

export async function swapJsBundle({
  context,
  root,
  iosDir,
  isExpo,
  cachedAppPath,
  logWriter = null,
  exec = null,
  spawnFn = null,
  mkdtemp = () => makeTemporaryDirectory(cachedAppPath, 'stim-js-swap-'),
  exists = existsSync,
  hermesEnabled = null,
  now = Date.now,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
  onHeartbeat = (line: string) => console.error(line),
}: {
  context?: StimContext;
  root: string;
  iosDir: string;
  isExpo: boolean;
  cachedAppPath: string;
  logWriter?: NdjsonWriter | null;
  exec?: Executor | null;
  spawnFn?: SpawnFn | null;
  mkdtemp?: () => string;
  exists?: (p: string) => boolean;
  hermesEnabled?: boolean | null;
  now?: () => number;
  heartbeatMs?: number;
  onHeartbeat?: (line: string) => void;
}): Promise<JsSwapResult> {
  const e = exec || getExecutor();
  const startedAt = now();
  const elapsed = () => now() - startedAt;
  let tmp: string | undefined;
  const fail = (step: string, reason: string, lastLines: string[] = []): JsSwapResult => {
    logWriter?.write?.({ src: 'build', level: 'error', msg: `JS swap failed at ${step}: ${reason}`, event: 'js_swap' });
    if (tmp) removeTemporaryEntry(tmp);
    return { failed: true, step, reason, lastLines, durationMs: elapsed() };
  };

  let appCopy: string;
  try {
    tmp = mkdtemp();
    appCopy = join(tmp, basename(cachedAppPath));
    try {
      await runOperationFile(context, e, 'cp', ['-c', '-R', cachedAppPath, appCopy], { timeoutMs: 'unbounded' });
    } catch {
      throwIfCancelled(context ? (operationState(context).runSignal ?? context.signal) : undefined, 'JS swap');
      removeTemporaryEntry(appCopy);
      await runOperationFile(context, e, 'cp', ['-R', cachedAppPath, appCopy], { timeoutMs: 'unbounded' });
    }
  } catch (err) {
    return fail('copy', `could not copy ${cachedAppPath} aside: ${describe(err)}`);
  }

  let catalogTarget: AssetCatalogTarget | null;
  const infoPlistPath = join(appCopy, 'Info.plist');
  try {
    catalogTarget = await readAssetCatalogTarget(context, e, infoPlistPath);
  } catch (err) {
    return fail('catalog', `could not read ${infoPlistPath}: ${describe(err)}`);
  }

  const bundleOutput = join(tmp, JS_BUNDLE_NAME);
  const assetsDest = join(tmp, 'assets');
  const catalogStaging = catalogTarget ? join(tmp, 'rn-assets') : null;
  const catalogDir = catalogStaging ? join(catalogStaging, 'RNAssets.xcassets') : null;
  const entryFile = isExpo ? 'index.js' : detectEntryFile(root);
  const command = bundleCommand({ isExpo, entryFile, bundleOutput, assetsDest, assetCatalogDest: catalogStaging });
  try {
    mkdirSync(assetsDest, { recursive: true });
  } catch (err) {
    return fail('bundle', `could not create ${assetsDest}: ${describe(err)}`);
  }
  if (catalogDir) {
    try {
      mkdirSync(catalogDir, { recursive: true });
    } catch (err) {
      return fail('bundle', `could not create ${catalogDir}: ${describe(err)}`);
    }
  }

  logWriter?.write?.({
    src: 'build',
    level: 'info',
    msg: `${command.file} ${command.args.join(' ')}`,
    event: 'js_swap',
  });

  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => e.spawn(cmd, args, opts));
  const transcript: string[] = [];
  const push = (line: unknown) => {
    const msg = cleanLine(line);
    if (msg.trim() === '') return;
    transcript.push(msg);
    logWriter?.write?.({ src: 'build', level: 'debug', msg, raw: true, event: 'js_swap' });
  };
  let child: ChildProcess;
  try {
    const invocation = bundleInvocation(root, isExpo, command.args.slice(1));
    child = spawnDeclared(context, () =>
      spawn(invocation.file, invocation.args, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: swapBundlerEnv(root, context?.env ?? process.env),
      }),
    );
    killOnAbort(context ? (operationState(context).runSignal ?? context.signal) : undefined)(child);
  } catch (err) {
    return fail('bundle', `could not run ${command.file} ${command.args[0]}: ${describe(err)}`);
  }
  const reader = { out: createLineReader(push), err: createLineReader(push) };
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => reader.out.push(chunk));
  child.stderr?.on('data', (chunk) => reader.err.push(chunk));
  const stopHeartbeat = startBuildHeartbeat({
    intervalMs: heartbeatMs,
    elapsed,
    emit: onHeartbeat,
    label: 'swap',
  });
  let outcome: Awaited<ReturnType<typeof waitForChild>>;
  try {
    outcome = await waitForChild(child);
  } finally {
    stopHeartbeat();
  }
  reader.out.flush();
  reader.err.flush();
  if (outcome.error) {
    return fail('bundle', `could not run ${command.file} ${command.args[0]}: ${describe(outcome.error)}`);
  }
  if (outcome.code !== 0) {
    const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.code}`;
    return fail(
      'bundle',
      `\`${command.args.slice(0, 2).join(' ')}\` failed (${how})`,
      tailLines(transcript, LAST_LINES),
    );
  }
  if (!exists(bundleOutput)) {
    return fail('bundle', `the bundle command exited 0 but wrote no ${JS_BUNDLE_NAME} at ${bundleOutput}`);
  }

  let hermes = false;
  let note: string | undefined;
  const wantsHermes = hermesEnabled ?? readHermesEnabled(iosDir);
  if (wantsHermes) {
    const hermesc = hermescPath(root, iosDir);
    if (!exists(hermesc)) {
      note = `hermesc not found at ${hermesc}; embedding the plain JS bundle instead of Hermes bytecode`;
    } else {
      const hbc = join(tmp, `${JS_BUNDLE_NAME}.hbc`);
      try {
        await runOperationFile(context, e, hermesc, hermescArgs({ bundle: bundleOutput, out: hbc }), {
          timeoutMs: 'unbounded',
        });
        await runOperationFile(context, e, 'mv', [hbc, bundleOutput], { timeoutMs: 30_000 });
        hermes = true;
      } catch (err) {
        return fail('hermesc', `hermesc failed on ${bundleOutput}: ${describe(err)}`);
      }
    }
  }

  try {
    await runOperationFile(context, e, 'cp', [bundleOutput, join(appCopy, JS_BUNDLE_NAME)], { timeoutMs: 'unbounded' });
    await runOperationFile(context, e, 'cp', ['-R', `${assetsDest}/.`, `${appCopy}/`], { timeoutMs: 'unbounded' });
  } catch (err) {
    return fail('replace', `could not replace the JS bundle inside ${appCopy}: ${describe(err)}`);
  }

  if (catalogTarget && catalogDir) {
    const catalogBundle = join(appCopy, ASSET_CATALOG_BUNDLE);
    try {
      rmSync(catalogBundle, { recursive: true, force: true });
      if (readdirSync(catalogDir).some((name) => name.endsWith('.imageset'))) {
        mkdirSync(catalogBundle);
        const output = await runOperationFile(
          context,
          e,
          'xcrun',
          actoolArgs({ catalog: catalogDir, out: catalogBundle, target: catalogTarget }),
          { timeoutMs: 'unbounded' },
        );
        if (!exists(join(catalogBundle, 'Assets.car'))) {
          return fail(
            'actool',
            `actool wrote no Assets.car into ${catalogBundle}`,
            tailLines(output.split('\n'), LAST_LINES),
          );
        }
        writeFileSync(join(catalogBundle, 'Info.plist'), ASSET_CATALOG_BUNDLE_INFO_PLIST);
      }
    } catch (err) {
      const stdout = String((err as { stdout?: unknown })?.stdout ?? '');
      return fail(
        'actool',
        `could not compile the image asset catalog into ${catalogBundle}: ${describe(err)}`,
        tailLines(stdout.split('\n'), LAST_LINES),
      );
    }
  }

  if (exists(join(appCopy, IOS_FRAMEWORK_UPDATES_MANIFEST))) {
    return fail(
      'updates',
      `the expo-updates manifest sits inside a nested framework (${IOS_FRAMEWORK_UPDATES_MANIFEST}), where a swap cannot refresh it without re-signing that framework`,
    );
  }
  for (const manifest of IOS_UPDATES_MANIFESTS.map((name) => join(appCopy, name)).filter(exists)) {
    try {
      refreshUpdatesManifestFile(manifest, now());
    } catch (err) {
      return fail('updates', `could not refresh the expo-updates manifest ${manifest}: ${describe(err)}`);
    }
  }

  try {
    await runOperationFile(context, e, 'codesign', ['--force', '--sign', '-', appCopy], { timeoutMs: 'unbounded' });
  } catch (err) {
    return fail('codesign', `codesign --force --sign - ${appCopy} failed: ${describe(err)}`);
  }

  logWriter?.write?.({
    src: 'build',
    level: 'info',
    msg: `JS swap done: ${hermes ? 'hermes bytecode' : 'plain JS'} into ${appCopy} in ${elapsed()}ms`,
    event: 'js_swap',
  });
  const result: JsSwapResult = { ok: true, appPath: appCopy, tmpDir: tmp, hermes, durationMs: elapsed() };
  if (note) result.note = note;
  return result;
}

function describe(err: unknown): string {
  return String((err as Error)?.message || err);
}
