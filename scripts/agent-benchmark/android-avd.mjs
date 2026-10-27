import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export function benchmarkAvdDescription(name, { reportedPath, allowedRoots = [] } = {}) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid benchmark AVD name');
  }
  const defaultHome = process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd');
  const directory =
    reportedPath === undefined ? join(defaultHome, `${name}.avd`) : reportedPath.trim().replace(/\r?\nOK$/, '');
  if (!isAbsolute(directory) || /[\r\n]/.test(directory) || basename(directory) !== `${name}.avd`) {
    throw new Error('Unverified benchmark AVD path');
  }
  const configPath = join(directory, 'config.ini');
  if (!existsSync(configPath)) {
    if (reportedPath === undefined) return { name, config: {} };
    throw new Error('Benchmark AVD configuration is unavailable');
  }
  const canonicalConfig = realpathSync(configPath);
  const contained = [defaultHome, ...allowedRoots].some((root) => {
    if (!existsSync(root)) return false;
    const path = relative(realpathSync(root), canonicalConfig);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  if (!contained || basename(dirname(canonicalConfig)) !== `${name}.avd`) {
    throw new Error('Benchmark AVD path is outside its allowed roots');
  }
  const indexPath = join(dirname(canonicalConfig), '..', `${name}.ini`);
  const indexedPath = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8')
        .match(/^path=(.+)$/m)?.[1]
        ?.trim()
    : null;
  if (!indexedPath || !isAbsolute(indexedPath) || realpathSync(indexedPath) !== dirname(canonicalConfig)) {
    throw new Error('Benchmark AVD index does not identify its configuration');
  }
  const config = Object.fromEntries(
    readFileSync(canonicalConfig, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  const systemImage = config['image.sysdir.1']?.replace(/\/+$/, '').replaceAll('/', ';');
  return {
    name,
    config,
    configPath: canonicalConfig,
    avdHome: dirname(dirname(canonicalConfig)),
    deviceTypeIdentifier: config['hw.device.name'],
    runtimeIdentifier: `Android-${systemImage?.match(/android-(\d+)/)?.[1]}`,
    systemImage,
  };
}
