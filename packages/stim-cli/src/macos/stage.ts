import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validMacosResourceDestination } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';

export function validateInfoPlist(
  root: string,
  product: string,
  infoPlist: string,
): { bundleId: string; minimumSystemVersion?: string } {
  const plist = JSON.parse(
    getExecutor().runFile('plutil', ['-convert', 'json', '-o', '-', realpathSync(resolve(root, infoPlist))]),
  );
  if (typeof plist.CFBundleIdentifier !== 'string' || plist.CFBundleExecutable !== product) {
    throw new Error('macos.infoPlist must name a CFBundleIdentifier and the selected product as CFBundleExecutable.');
  }
  if (plist.CFBundleURLTypes || plist.SUFeedURL) {
    throw new Error('Use a development Info.plist without shared URL schemes or an update feed.');
  }
  if (plist.LSMinimumSystemVersion !== undefined && typeof plist.LSMinimumSystemVersion !== 'string') {
    throw new Error('macos.infoPlist LSMinimumSystemVersion must be a string. See stim guide macos.');
  }
  return { bundleId: plist.CFBundleIdentifier, minimumSystemVersion: plist.LSMinimumSystemVersion };
}

export interface BundleExtras {
  resources: Record<string, string>;
  assetCatalog?: string;
}

function resourceError(key: string, entry: unknown, reason: string): never {
  throw new Error(`${key} entry ${JSON.stringify(entry)}: ${reason}. See stim guide macos.`);
}

function overlaps(a: string, b: string): boolean {
  a = a.normalize('NFC').toLowerCase();
  b = b.normalize('NFC').toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function resolveBundleExtras(
  root: string,
  repository: string,
  resources: unknown = {},
  assetCatalog?: unknown,
): BundleExtras {
  const boundary = realpathSync(repository);
  const sourcePath = (key: string, entry: unknown): string => {
    if (typeof entry !== 'string' || !entry || isAbsolute(entry) || entry.includes('\0'))
      resourceError(key, entry, 'source must be a non-empty relative path');
    let source: string;
    try {
      source = realpathSync(resolve(root, entry));
    } catch {
      resourceError(key, entry, 'source does not exist');
    }
    const path = relative(boundary, source);
    if (path === '..' || path.startsWith('../') || isAbsolute(path))
      resourceError(key, entry, 'source leaves the repository');
    const stat = statSync(source);
    if (!stat.isFile() && !stat.isDirectory()) resourceError(key, entry, 'source must be a regular file or directory');
    return source;
  };
  let catalog: string | undefined;
  if (assetCatalog !== undefined && assetCatalog !== null) {
    catalog = sourcePath('macos.assetCatalog', assetCatalog);
    if (!catalog.endsWith('.xcassets') || !statSync(catalog).isDirectory())
      resourceError('macos.assetCatalog', assetCatalog, 'catalog must be a .xcassets directory');
  }
  if (!resources || typeof resources !== 'object' || Array.isArray(resources))
    resourceError('macos.resources', resources, 'expected an object');
  const entries = Object.entries(resources);
  if (entries.length > 256) resourceError('macos.resources', 'map', 'at most 256 entries are allowed');
  const reserved = catalog ? ['Assets.car'] : [];
  const resolved: Array<[string, string]> = [];
  for (const [destination, source] of entries) {
    const key = `macos.resources[${JSON.stringify(destination)}]`;
    if (!validMacosResourceDestination(destination)) resourceError(key, source, 'invalid destination');
    if (reserved.some((other) => overlaps(destination, other)))
      resourceError(key, source, 'destination collides with another resource');
    reserved.push(destination);
    resolved.push([destination, sourcePath(key, source)]);
  }
  return { resources: Object.fromEntries(resolved), assetCatalog: catalog };
}

export function stageBundle(
  root: string,
  product: string,
  infoPlist: string,
  bin: string,
  bundle: string,
  bundleId: string,
  extras: BundleExtras = { resources: {} },
): void {
  const { minimumSystemVersion } = validateInfoPlist(root, product, infoPlist);
  for (const entry of readdirSync(bin).filter((name) => name.endsWith('.bundle'))) {
    for (const [destination, source] of Object.entries(extras.resources)) {
      if (overlaps(destination, entry))
        resourceError(`macos.resources[${JSON.stringify(destination)}]`, source, `destination collides with ${entry}`);
    }
  }
  const exec = getExecutor();
  rmSync(bundle, { recursive: true, force: true });
  const contents = join(bundle, 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  mkdirSync(join(contents, 'Frameworks'), { recursive: true });
  const executable = join(contents, 'MacOS', product);
  cpSync(join(bin, product), executable);
  cpSync(resolve(root, infoPlist), join(contents, 'Info.plist'));
  exec.runFile('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${bundleId}`, join(contents, 'Info.plist')]);
  for (const entry of readdirSync(bin)) {
    if (entry.endsWith('.framework')) {
      const target = join(contents, 'Frameworks', entry);
      cpSync(join(bin, entry), target, { recursive: true, dereference: false, verbatimSymlinks: true });
      exec.runFile('codesign', ['--force', '--sign', '-', target]);
    } else if (entry.endsWith('.bundle'))
      cpSync(join(bin, entry), join(contents, 'Resources', entry), { recursive: true });
  }
  const frameworkPath = '@executable_path/../Frameworks';
  if (!exec.runFile('otool', ['-l', executable]).includes(frameworkPath)) {
    exec.runFile('install_name_tool', ['-add_rpath', frameworkPath, executable]);
  }
  for (const [destination, source] of Object.entries(extras.resources)) {
    const target = join(contents, 'Resources', destination);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  if (extras.assetCatalog) {
    exec.runFile('xcrun', [
      'actool',
      extras.assetCatalog,
      '--compile',
      join(contents, 'Resources'),
      '--platform',
      'macosx',
      ...(minimumSystemVersion === undefined ? [] : ['--minimum-deployment-target', minimumSystemVersion]),
      '--output-partial-info-plist',
      '/dev/null',
    ]);
    if (!existsSync(join(contents, 'Resources', 'Assets.car')))
      resourceError('macos.assetCatalog', extras.assetCatalog, 'actool did not produce Assets.car');
  }
  exec.runFile('codesign', ['--force', '--sign', '-', bundle]);
}
