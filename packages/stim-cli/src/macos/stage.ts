import { promises as fs, existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type StimContext, validMacosResourceDestination } from '@stim-cli/core';
import { getExecutor, type ExecOptions } from '../exec.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { withDrainingCancellation } from '../engine/operation-state.ts';

export async function validateInfoPlist(
  context: StimContext,
  root: string,
  product: string,
  infoPlist: string,
): Promise<{ bundleId: string; minimumSystemVersion?: string }> {
  const source = resolve(root, infoPlist);
  const inside = relative(realpathSync(root), realpathSync(source));
  if (!lstatSync(source).isFile() || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(
      'macos.infoPlist must be a regular file inside the project, not a symbolic link. See stim guide macos.',
    );
  }
  const plist = JSON.parse(
    await tool(context, 'plutil', ['-convert', 'json', '-o', '-', source], { timeoutMs: 10_000 }),
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

export async function setBundleName(context: StimContext, plistPath: string, name: string): Promise<void> {
  for (const key of ['CFBundleDisplayName', 'CFBundleName'])
    await tool(context, 'plutil', ['-replace', key, '-string', name, plistPath], { timeoutMs: 10_000 });
}

export async function reidentifyBundle(context: StimContext, bundle: string, id: string, name?: string): Promise<void> {
  const plist = join(bundle, 'Contents', 'Info.plist');
  await tool(context, 'plutil', ['-replace', 'CFBundleIdentifier', '-string', id, plist], { timeoutMs: 10_000 });
  if (name !== undefined) await setBundleName(context, plist, name);
  await tool(context, 'codesign', ['--force', '--sign', '-', bundle], { timeoutMs: 'unbounded' });
}

export interface BundleExtras {
  resources: Record<string, string>;
  assetCatalog?: string;
}

function resourceError(key: string, entry: unknown, reason: string): never {
  throw new Error(`${key} entry ${JSON.stringify(entry)}: ${reason}. See stim guide macos.`);
}

function containsSymlink(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some(
    (entry) => entry.isSymbolicLink() || (entry.isDirectory() && containsSymlink(join(dir, entry.name))),
  );
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
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      resourceError(key, entry, 'source leaves the repository');
    if (path === '') resourceError(key, entry, 'source is the repository root');
    const stat = statSync(source);
    if (!stat.isFile() && !stat.isDirectory()) resourceError(key, entry, 'source must be a regular file or directory');
    if (stat.isDirectory() && containsSymlink(source))
      resourceError(key, entry, 'source directory contains a symbolic link');
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
  if (entries.length > 256) {
    const [destination, source] = entries[256]!;
    resourceError(`macos.resources[${JSON.stringify(destination)}]`, source, 'at most 256 entries are allowed');
  }
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

export async function stageBundle(
  context: StimContext,
  root: string,
  product: string,
  infoPlist: string,
  bin: string,
  bundle: string,
  bundleId: string,
  extras: BundleExtras = { resources: {} },
  displayName?: string,
): Promise<void> {
  const signal = runCancellationSignal(context) ?? context.signal;
  await withDrainingCancellation(context, signal, async () => {
    throwIfCancelled(signal, 'macOS bundle staging');
    const { minimumSystemVersion } = await validateInfoPlist(context, root, product, infoPlist);
    const entries = readdirSync(bin);
    for (const entry of entries.filter((name) => name.endsWith('.bundle'))) {
      for (const [destination, source] of Object.entries(extras.resources)) {
        if (overlaps(destination, entry))
          resourceError(
            `macos.resources[${JSON.stringify(destination)}]`,
            source,
            `destination collides with ${entry}`,
          );
      }
    }
    await fs.rm(bundle, { recursive: true, force: true });
    const contents = join(bundle, 'Contents');
    await fs.mkdir(join(contents, 'MacOS'), { recursive: true });
    await fs.mkdir(join(contents, 'Resources'), { recursive: true });
    await fs.mkdir(join(contents, 'Frameworks'), { recursive: true });
    const executable = join(contents, 'MacOS', product);
    await copy(context, join(bin, product), executable);
    await copy(context, resolve(root, infoPlist), join(contents, 'Info.plist'));
    await tool(
      context,
      '/usr/libexec/PlistBuddy',
      ['-c', `Set :CFBundleIdentifier ${bundleId}`, join(contents, 'Info.plist')],
      {
        timeoutMs: 10_000,
      },
    );
    if (displayName !== undefined) await setBundleName(context, join(contents, 'Info.plist'), displayName);
    for (const entry of entries) {
      if (entry.endsWith('.framework')) {
        const target = join(contents, 'Frameworks', entry);
        await copy(context, join(bin, entry), target, { recursive: true, dereference: false, verbatimSymlinks: true });
        await tool(context, 'codesign', ['--force', '--sign', '-', target], { timeoutMs: 'unbounded' });
      } else if (entry.endsWith('.bundle'))
        await copy(context, join(bin, entry), join(contents, 'Resources', entry), { recursive: true });
    }
    const frameworkPath = '@executable_path/../Frameworks';
    if (
      entries.some((entry) => entry.endsWith('.framework')) &&
      !(await tool(context, 'otool', ['-l', executable], { timeoutMs: 30_000 })).includes(frameworkPath)
    ) {
      await tool(context, 'install_name_tool', ['-add_rpath', frameworkPath, executable], { timeoutMs: 30_000 });
    }
    for (const [destination, source] of Object.entries(extras.resources)) {
      const target = join(contents, 'Resources', destination);
      await fs.mkdir(dirname(target), { recursive: true });
      await copy(context, source, target, { recursive: true });
    }
    if (extras.assetCatalog) {
      await tool(
        context,
        'xcrun',
        [
          'actool',
          extras.assetCatalog,
          '--compile',
          join(contents, 'Resources'),
          '--platform',
          'macosx',
          ...(minimumSystemVersion === undefined ? [] : ['--minimum-deployment-target', minimumSystemVersion]),
          '--output-partial-info-plist',
          '/dev/null',
        ],
        { timeoutMs: 'unbounded' },
      );
      if (!existsSync(join(contents, 'Resources', 'Assets.car')))
        resourceError('macos.assetCatalog', extras.assetCatalog, 'actool did not produce Assets.car');
    }
    await tool(context, 'codesign', ['--force', '--sign', '-', bundle], { timeoutMs: 'unbounded' });
  });
}

async function tool(context: StimContext, file: string, args: string[], options: ExecOptions): Promise<string> {
  const signal = runCancellationSignal(context) ?? context.signal;
  throwIfCancelled(signal, 'macOS bundle staging');
  const result = await getExecutor().runFileAsync(file, args, { ...options, declareFor: context });
  throwIfCancelled(signal, 'macOS bundle staging');
  return result;
}

async function copy(
  context: StimContext,
  source: string,
  target: string,
  options: Parameters<typeof fs.cp>[2] = {},
): Promise<void> {
  const signal = runCancellationSignal(context) ?? context.signal;
  throwIfCancelled(signal, 'macOS bundle staging');
  // Node filesystem copies cannot abort an in-flight file; await it before staging cleanup.
  await fs.cp(source, target, {
    ...options,
    filter: () => {
      throwIfCancelled(signal, 'macOS bundle staging');
      return true;
    },
  });
  throwIfCancelled(signal, 'macOS bundle staging');
}
