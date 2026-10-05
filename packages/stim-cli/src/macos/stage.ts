import { cpSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';

export function validateInfoPlist(root: string, product: string, infoPlist: string): string {
  const plist = JSON.parse(
    getExecutor().runFile('plutil', ['-convert', 'json', '-o', '-', realpathSync(resolve(root, infoPlist))]),
  );
  if (typeof plist.CFBundleIdentifier !== 'string' || plist.CFBundleExecutable !== product) {
    throw new Error('macos.infoPlist must name a CFBundleIdentifier and the selected product as CFBundleExecutable.');
  }
  if (plist.CFBundleURLTypes || plist.SUFeedURL) {
    throw new Error('Use a development Info.plist without shared URL schemes or an update feed.');
  }
  return plist.CFBundleIdentifier;
}

export function stageBundle(
  root: string,
  product: string,
  infoPlist: string,
  bin: string,
  bundle: string,
  bundleId: string,
): void {
  validateInfoPlist(root, product, infoPlist);
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
  exec.runFile('codesign', ['--force', '--sign', '-', bundle]);
}
