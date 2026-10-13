import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** How `discoverToolchain` and `projectNodeBin` look at this machine; tests pass a fake file system. */
export interface ToolchainProbe {
  home: string;
  /** The running Node, whose directory is the last `PATH` entry so `node` always resolves. */
  execPath: string;
  isDir(path: string): boolean;
  isFile(path: string): boolean;
  read(path: string): string | null;
  list(path: string): string[];
}

const stat = (path: string) => statSync(path, { throwIfNoEntry: false });

export function defaultToolchainProbe(): ToolchainProbe {
  return {
    home: homedir(),
    execPath: process.execPath,
    isDir: (path) => stat(path)?.isDirectory() ?? false,
    isFile: (path) => stat(path)?.isFile() ?? false,
    read: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    list: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
  };
}

/**
 * One toolchain fact for `stim doctor`: `source` is `environment` when the caller's environment already set it,
 * `discovered` when `discoverToolchain` found it at `from`, and `missing` when neither did. A discovered
 * `JAVA_HOME` for a system JDK is reported but not set, since `/usr/bin/java` already finds it.
 */
export interface ToolchainEntry {
  name: string;
  value: string | null;
  source: 'environment' | 'discovered' | 'missing';
  from?: string;
}

export interface Toolchain {
  env: Record<string, string>;
  entries: ToolchainEntry[];
}

const HOMEBREW_BINS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
const SYSTEM_JDKS = '/Library/Java/JavaVirtualMachines';
const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local'];

/** Homebrew JDKs in the order Android builds prefer them: 17, then 21, then the rest from newest. */
function jdkRank(name: string): number {
  const major = Number(/@(\d+)$/.exec(name)?.[1] ?? 1000);
  return major === 17 ? 0 : major === 21 ? 1 : 10_000 - major;
}
const ANDROID_STUDIOS = ['/Applications/Android Studio.app', '/Applications/Android Studio Preview.app'];

type Version = [number, number, number];

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The newest installed version, of `names` such as `v22.12.0` or `22.12.0`, that `wanted` names. */
function newestMatching(names: string[], wanted: string): string | null {
  const spec = wanted.trim().replace(/^v/, '');
  const exact = parseVersion(spec);
  let best: { name: string; version: Version } | null = null;
  for (const name of names) {
    const version = parseVersion(name);
    if (!version) continue;
    if (exact ? compareVersions(version, exact) !== 0 : !matchesPrefix(version, spec)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { name, version };
  }
  return best?.name ?? null;
}

/** Whether Node `version`, such as `22.12.0`, satisfies a pin such as `22`, `v22.12` or `22.12.0`. */
export function satisfiesNodePin(version: string, spec: string): boolean {
  return newestMatching([version], spec) !== null;
}

function matchesPrefix(version: Version, spec: string): boolean {
  if (spec === '' || spec === 'node' || spec === 'stable') return true;
  const parts = spec.split('.');
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return false;
  return parts.every((part, index) => Number(part) === version[index]);
}

/** nvm's `alias/<name>` chain, which can name another alias such as `lts/*`, down to a version spec. */
function nvmAlias(nvm: string, name: string, probe: ToolchainProbe): string {
  let spec = name;
  for (let hops = 0; hops < 8; hops++) {
    const next = probe.read(join(nvm, 'alias', spec))?.trim();
    if (!next) return spec;
    spec = next;
  }
  return spec;
}

function nvmDir(env: NodeJS.ProcessEnv, probe: ToolchainProbe): string {
  return env.NVM_DIR || join(probe.home, '.nvm');
}

/** The `bin` directory of the Node a version manager makes the default in new shells, and where that came from. */
export function defaultNodeBin(env: NodeJS.ProcessEnv, probe: ToolchainProbe): { bin: string; from: string } | null {
  const nvm = nvmDir(env, probe);
  if (probe.isFile(join(nvm, 'alias', 'default'))) {
    const spec = nvmAlias(nvm, 'default', probe);
    const version = newestMatching(probe.list(join(nvm, 'versions', 'node')), spec);
    if (version) return { bin: join(nvm, 'versions', 'node', version, 'bin'), from: `nvm default (${spec})` };
  }
  const managed = [
    { bin: join(probe.home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'), from: 'fnm default' },
    {
      bin: join(probe.home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
      from: 'fnm default',
    },
    { bin: join(probe.home, '.volta', 'bin'), from: 'Volta' },
    { bin: join(probe.home, '.local', 'share', 'mise', 'shims'), from: 'mise shims' },
    { bin: join(env.ASDF_DATA_DIR || join(probe.home, '.asdf'), 'shims'), from: 'asdf shims' },
  ];
  return managed.find(({ bin }) => probe.isFile(join(bin, 'node'))) ?? null;
}

function pathEntries(path: string | undefined): string[] {
  return (path ?? '').split(delimiter).filter(Boolean);
}

/**
 * The toolchain environment a process started outside a login shell, such as stim-server under Stim Desktop or
 * launchd, needs: `base` with Homebrew, `~/.local/bin`, the default Node's directory and the Android SDK tools
 * appended to `PATH`, and `ANDROID_HOME` and `JAVA_HOME` set when `base` lacks them and they can be found. It only
 * fills gaps: nothing `base` sets is replaced, and every added `PATH` entry goes after the existing ones. Unless
 * `runningNode` is false, the running Node's directory is always the last entry, so `node` resolves. `PNPM_HOME` is
 * set to pnpm's global directory when that is added, since pnpm's global commands need it.
 */
export function discoverToolchain(
  base: NodeJS.ProcessEnv,
  probe: ToolchainProbe = defaultToolchainProbe(),
  { runningNode = true }: { runningNode?: boolean } = {},
): Toolchain {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  const entries: ToolchainEntry[] = [];
  const path = pathEntries(env.PATH);
  const append = (dir: string) => {
    if (!path.includes(dir) && probe.isDir(dir)) path.push(dir);
  };
  const onPath = (name: string) => path.find((dir) => probe.isFile(join(dir, name))) ?? null;

  const nodeBefore = onPath('node');
  const defaultNode = nodeBefore ? null : defaultNodeBin(env, probe);
  if (defaultNode) append(defaultNode.bin);
  for (const dir of HOMEBREW_BINS) append(dir);
  for (const dir of ['.local/bin', 'Library/pnpm', '.bun/bin']) append(join(probe.home, dir));
  const pnpmHome = join(probe.home, 'Library', 'pnpm');
  if (!env.PNPM_HOME && path.includes(pnpmHome)) env.PNPM_HOME = pnpmHome;

  const sdkSet = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const standardSdk = join(probe.home, 'Library', 'Android', 'sdk');
  const sdk = sdkSet || (probe.isDir(standardSdk) ? standardSdk : null);
  if (sdk && !sdkSet) env.ANDROID_HOME = sdk;
  if (sdk) for (const tools of ['platform-tools', 'emulator']) append(join(sdk, tools));
  entries.push(
    sdkSet
      ? { name: 'ANDROID_HOME', value: sdkSet, source: 'environment' }
      : sdk
        ? { name: 'ANDROID_HOME', value: sdk, source: 'discovered', from: 'the Android Studio default location' }
        : { name: 'ANDROID_HOME', value: null, source: 'missing' },
  );

  entries.push(javaEntry(env, probe));
  const running = dirname(probe.execPath);
  if (runningNode) append(running);
  env.PATH = path.join(delimiter);

  const node = onPath('node');
  const nodeFrom = nodeBefore
    ? null
    : defaultNode && node === defaultNode.bin
      ? defaultNode.from
      : node === running
        ? 'the Node running Stim'
        : node && `${node} on the discovered PATH`;
  entries.unshift({
    name: 'node',
    value: node && join(node, 'node'),
    source: nodeBefore ? 'environment' : 'discovered',
    ...(nodeFrom ? { from: nodeFrom } : {}),
  });
  for (const tool of ['stim', 'brew', 'adb']) {
    const dir = onPath(tool);
    entries.push(
      dir
        ? {
            name: tool,
            value: join(dir, tool),
            source: pathEntries(base.PATH).includes(dir) ? 'environment' : 'discovered',
          }
        : { name: tool, value: null, source: 'missing' },
    );
  }
  return { env, entries };
}

/**
 * `JAVA_HOME` for Gradle. A JDK under /Library/Java/JavaVirtualMachines needs none, because `/usr/bin/java` finds
 * it. Without one, a Homebrew `openjdk`, which /usr/bin/java does not find, is set (17, then 21, then the newest),
 * else Android Studio's bundled runtime.
 */
function javaEntry(env: Record<string, string>, probe: ToolchainProbe): ToolchainEntry {
  if (env.JAVA_HOME) return { name: 'JAVA_HOME', value: env.JAVA_HOME, source: 'environment' };
  const system = probe
    .list(SYSTEM_JDKS)
    .map((name) => join(SYSTEM_JDKS, name, 'Contents', 'Home'))
    .find((home) => probe.isFile(join(home, 'bin', 'java')));
  if (system)
    return { name: 'JAVA_HOME', value: system, source: 'discovered', from: 'a system JDK, which /usr/bin/java runs' };
  const brewed = HOMEBREW_PREFIXES.flatMap((prefix) =>
    probe
      .list(join(prefix, 'opt'))
      .filter((name) => /^openjdk(@\d+)?$/.test(name))
      .map((name) => ({ name, home: join(prefix, 'opt', name, 'libexec', 'openjdk.jdk', 'Contents', 'Home') })),
  )
    .filter(({ home }) => probe.isFile(join(home, 'bin', 'java')))
    .toSorted((a, b) => jdkRank(a.name) - jdkRank(b.name))[0];
  if (brewed) {
    env.JAVA_HOME = brewed.home;
    return { name: 'JAVA_HOME', value: brewed.home, source: 'discovered', from: `Homebrew ${brewed.name}` };
  }
  for (const studio of ANDROID_STUDIOS) {
    const jbr = join(studio, 'Contents', 'jbr', 'Contents', 'Home');
    if (probe.isFile(join(jbr, 'bin', 'java'))) {
      env.JAVA_HOME = jbr;
      return { name: 'JAVA_HOME', value: jbr, source: 'discovered', from: "Android Studio's bundled runtime" };
    }
  }
  return { name: 'JAVA_HOME', value: null, source: 'missing' };
}

/** The Node version `root` pins, from `.nvmrc`, `.node-version`, `.tool-versions` or `package.json`'s `volta.node`. */
export function projectNodePin(
  root: string,
  probe: ToolchainProbe = defaultToolchainProbe(),
): { spec: string; file: string } | null {
  for (const file of ['.nvmrc', '.node-version']) {
    const line = probe
      .read(join(root, file))
      ?.split('\n')
      .map((text) => text.trim())
      .find((text) => text && !text.startsWith('#'));
    if (line) return { spec: line, file };
  }
  const tools = probe.read(join(root, '.tool-versions'));
  const asdf = tools && /^nodejs\s+(\S+)/m.exec(tools)?.[1];
  if (asdf) return { spec: asdf, file: '.tool-versions' };
  const volta = /"volta"\s*:\s*\{[^}]*"node"\s*:\s*"([^"]+)"/.exec(probe.read(join(root, 'package.json')) ?? '')?.[1];
  return volta ? { spec: volta, file: 'package.json' } : null;
}

/**
 * The `bin` directory of an installed Node that satisfies `root`'s pin, from nvm, fnm, Volta, asdf or mise, or
 * nil when the project pins none or no installed version satisfies the pin. An `lts/...` pin resolves through
 * nvm's aliases.
 */
export function projectNodeBin(
  root: string,
  env: NodeJS.ProcessEnv,
  probe: ToolchainProbe = defaultToolchainProbe(),
): { bin: string; version: string; pin: string; spec: string } | null {
  const pin = projectNodePin(root, probe);
  if (!pin) return null;
  const nvm = nvmDir(env, probe);
  const spec = pin.spec.startsWith('lts/') ? nvmAlias(nvm, pin.spec, probe) : pin.spec;
  const stores = [
    { dir: join(nvm, 'versions', 'node'), bin: (name: string) => join(nvm, 'versions', 'node', name, 'bin') },
    {
      dir: join(probe.home, '.local', 'share', 'fnm', 'node-versions'),
      bin: (name: string) => join(probe.home, '.local', 'share', 'fnm', 'node-versions', name, 'installation', 'bin'),
    },
    {
      dir: join(probe.home, 'Library', 'Application Support', 'fnm', 'node-versions'),
      bin: (name: string) =>
        join(probe.home, 'Library', 'Application Support', 'fnm', 'node-versions', name, 'installation', 'bin'),
    },
    {
      dir: join(probe.home, '.volta', 'tools', 'image', 'node'),
      bin: (name: string) => join(probe.home, '.volta', 'tools', 'image', 'node', name, 'bin'),
    },
    {
      dir: join(env.ASDF_DATA_DIR || join(probe.home, '.asdf'), 'installs', 'nodejs'),
      bin: (name: string) => join(env.ASDF_DATA_DIR || join(probe.home, '.asdf'), 'installs', 'nodejs', name, 'bin'),
    },
    {
      dir: join(probe.home, '.local', 'share', 'mise', 'installs', 'node'),
      bin: (name: string) => join(probe.home, '.local', 'share', 'mise', 'installs', 'node', name, 'bin'),
    },
  ];
  for (const store of stores) {
    const name = newestMatching(probe.list(store.dir), spec);
    if (name && probe.isFile(join(store.bin(name), 'node'))) {
      return { bin: store.bin(name), version: name.replace(/^v/, ''), pin: pin.file, spec };
    }
  }
  return null;
}
