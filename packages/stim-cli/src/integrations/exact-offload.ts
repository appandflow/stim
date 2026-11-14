import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { isJsonObject } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { gitQuiet } from '../workspace/git.ts';

/** The Rust target an Exact iOS simulator build compiles for; Exact's own setup does not install it. */
export const EXACT_SIM_TARGET = 'aarch64-apple-ios-sim';

const SHA = /^[0-9a-f]{40}$/;
const BUN_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const RUST_CHANNEL = /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/;
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SETTING = /^[A-Z][A-Z0-9_]*$/;
const REMOTE_URL =
  /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d{1,5})?|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)[A-Za-z0-9._~/-]{1,300}$/;
const LINK = /^(?:\.\.\/){1,16}(?:(?!\.\.?\/)[A-Za-z0-9._-]{1,100}\/){0,16}(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const MAX_SETTINGS = 64;
const MAX_SETTING_BYTES = 16 * 1024;

/**
 * The versions of Bun, Rust and exact2 an Exact app builds with, as its own launcher and exact2 checkout pin them, the
 * name of the folder that holds that exact2 checkout, and a remote URL that has the exact2 commit, when one is known.
 */
export interface ExactPins {
  exact2: string;
  bun: string;
  rust: string;
  checkout: string;
  url: string | null;
}

/**
 * What an offloaded Exact build carries besides the synced checkout: the checkout directory's name for apps at the
 * Git root (Exact names its generated crates after it), the pins, each declared setting's value, and the path from the
 * app directory to its exact2 checkout when that path climbs out of the repository (the app's Cargo manifests name
 * exact2's crates by it).
 */
export interface ExactOffload extends ExactPins {
  name: string;
  env: Record<string, string>;
  link: string | null;
}

/** One missing piece of Exact's toolchain on a build machine, with the commands that install it there. */
export interface ExactToolProblem {
  reason: string;
  commands: string[];
}

function readManifest(root: string): Record<string, unknown> | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
    return isJsonObject(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

/** Whether `app.json` declares native modules, whose roster Exact may read by running code on a simulator. */
export function exactDeclaresModules(manifest: Record<string, unknown>): boolean {
  const { modules } = manifest;
  return Array.isArray(modules) ? modules.length > 0 : modules !== undefined && modules !== null;
}

export function exactDeclaredSettings(manifest: Record<string, unknown>): string[] {
  return Array.isArray(manifest.env)
    ? [...new Set(manifest.env.filter((name): name is string => typeof name === 'string' && SETTING.test(name)))]
    : [];
}

/**
 * The declared settings' values in Exact's order: this process's environment, then `.env.local`, then `.env`, each in
 * Node's dotenv grammar as Exact parses them.
 */
function exactSettingValues(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  files: readonly string[],
): Record<string, string> {
  const parsed = files.map((text) => parseEnv(text));
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = env[name] ?? parsed.find((file) => Object.hasOwn(file, name))?.[name];
    if (value !== undefined) values[name] = value;
  }
  return values;
}

function exactLauncherPins(launcher: string): { bun: string | null; exact2Default: string | null } {
  return {
    bun: /ensureBun\(\s*["'](\d+\.\d+\.\d+)["']\s*\)/.exec(launcher)?.[1] ?? null,
    exact2Default: /process\.env\.EXACT2\s*\?\?\s*(["'])([^"'\n]+)\1/.exec(launcher)?.[2] ?? null,
  };
}

function exactRustChannel(toolchain: string): string | null {
  const channel = /^\s*channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1];
  return channel && RUST_CHANNEL.test(channel) ? channel : null;
}

function git(dir: string, args: string[]): string | null {
  return getExecutor().runFileQuiet('git', ['-C', dir, ...args], { timeoutMs: 20_000 });
}

/** What an offloaded build of the Exact app at `root` carries, or why it builds on this Mac. */
export function exactOffloadPlan(root: string, env: NodeJS.ProcessEnv): ExactOffload | { unsupported: string } {
  const manifest = readManifest(root);
  if (!manifest) return { unsupported: 'app.json is not a JSON object' };
  let launcher: string;
  try {
    launcher = readFileSync(join(root, 'exact.mjs'), 'utf8');
  } catch {
    return { unsupported: 'exact.mjs is not readable' };
  }
  const { bun, exact2Default } = exactLauncherPins(launcher);
  const exact2Path = env.EXACT2 ?? exact2Default;
  if (!bun || exact2Path === null)
    return { unsupported: 'exact.mjs does not name its Bun version and exact2 checkout the way Stim reads them' };
  let exact2Dir: string;
  try {
    exact2Dir = realpathSync(resolve(root, exact2Path));
  } catch {
    return { unsupported: `there is no exact2 checkout at ${resolve(root, exact2Path)} (set EXACT2)` };
  }
  let rust: string | null = null;
  try {
    rust = exactRustChannel(readFileSync(join(exact2Dir, 'rust-toolchain.toml'), 'utf8'));
  } catch {}
  if (!rust) return { unsupported: `${exact2Dir}/rust-toolchain.toml names no Rust channel` };
  const exact2 = git(exact2Dir, ['rev-parse', 'HEAD']);
  if (!exact2 || !SHA.test(exact2)) return { unsupported: `${exact2Dir} is not a git checkout of exact2` };
  const changes = git(exact2Dir, ['status', '--porcelain', '--untracked-files=no']);
  if (changes === null || changes !== '')
    return { unsupported: `the exact2 checkout at ${exact2Dir} has local changes a build machine would not have` };
  const checkout = basename(exact2Dir);
  if (!APP_NAME.test(checkout))
    return {
      unsupported: `the exact2 checkout folder name ${JSON.stringify(checkout)} is not a plain ASCII file name`,
    };
  const canonicalRoot = realpathSync(root);
  let name = basename(canonicalRoot);
  if (!APP_NAME.test(name)) {
    if (!gitQuiet(canonicalRoot, ['rev-parse', '--show-prefix']))
      return { unsupported: `the app directory name ${JSON.stringify(name)} is not a plain ASCII file name` };
    // The worker reads this required field only when the project is at the Git root.
    name = 'app';
  }
  const link = exact2Link(canonicalRoot, exact2Dir);
  if (typeof link === 'object' && link !== null) return link;
  const files: string[] = [];
  for (const file of ['.env.local', '.env']) {
    try {
      if (existsSync(join(root, file))) files.push(readFileSync(join(root, file), 'utf8'));
    } catch {
      return { unsupported: `${file} is not readable` };
    }
  }
  return {
    name,
    exact2,
    bun,
    rust,
    checkout,
    url: exactRemoteUrl(exact2Dir),
    env: exactSettingValues(exactDeclaredSettings(manifest), env, files),
    link,
  };
}

/**
 * The path from the app directory to exact2 as the app's Cargo manifests name it, when it leaves the repository: Exact
 * writes it relative when the two share their top directory and absolute otherwise (exact2 `scripts/app.mjs`
 * `pathFrom`). Null when exact2 is inside the repository.
 */
function exact2Link(app: string, exact2Dir: string): string | null | { unsupported: string } {
  const top = gitQuiet(app, ['rev-parse', '--show-toplevel']);
  const repo = top ? realpathSync(top) : app;
  const inRepo = relative(repo, exact2Dir);
  if (inRepo === '' || (!inRepo.startsWith('..') && !isAbsolute(inRepo))) return null;
  if (app.split(sep)[1] !== exact2Dir.split(sep)[1])
    return {
      unsupported: `the exact2 checkout at ${exact2Dir} shares no top directory with the app, so its Cargo manifests name it by an absolute path a build machine does not have`,
    };
  const link = relative(app, exact2Dir).split(sep).join('/');
  return LINK.test(link) ? link : { unsupported: `the path ${link} from the app to exact2 is not one Stim places` };
}

/** A remote URL of the exact2 checkout whose fetched branches hold its commit, without credentials; null when none does. */
function exactRemoteUrl(exact2Dir: string): string | null {
  const branches = git(exact2Dir, ['branch', '-r', '--contains', 'HEAD', '--format=%(refname:lstrip=2)']);
  const remotes = (git(exact2Dir, ['remote']) ?? '').split('\n').filter(Boolean);
  for (const branch of (branches ?? '').split('\n')) {
    const remote = remotes.find((each) => branch.startsWith(`${each}/`));
    const url = remote ? git(exact2Dir, ['remote', 'get-url', remote]) : null;
    if (url && REMOTE_URL.test(url)) return url;
  }
  return null;
}

export function exactPinsParam(value: unknown): ExactPins | null {
  if (!isJsonObject(value)) return null;
  const { exact2, bun, rust, checkout, url } = value;
  return typeof exact2 === 'string' &&
    SHA.test(exact2) &&
    typeof bun === 'string' &&
    BUN_VERSION.test(bun) &&
    typeof rust === 'string' &&
    RUST_CHANNEL.test(rust) &&
    typeof checkout === 'string' &&
    APP_NAME.test(checkout) &&
    (url === null || (typeof url === 'string' && REMOTE_URL.test(url)))
    ? { exact2, bun, rust, checkout, url }
    : null;
}

export function exactOffloadParam(value: unknown): ExactOffload | null {
  const pins = exactPinsParam(value);
  if (!pins || !isJsonObject(value)) return null;
  const { name, env, link } = value;
  if (typeof name !== 'string' || !APP_NAME.test(name) || !isJsonObject(env)) return null;
  if (link !== null && (typeof link !== 'string' || !LINK.test(link))) return null;
  const entries = Object.entries(env);
  if (
    entries.length > MAX_SETTINGS ||
    entries.some(
      ([key, setting]) =>
        !SETTING.test(key) ||
        typeof setting !== 'string' ||
        setting.includes('\0') ||
        Buffer.byteLength(setting) > MAX_SETTING_BYTES,
    )
  )
    return null;
  const settings: Record<string, string> = {};
  for (const [key, setting] of entries) if (typeof setting === 'string') settings[key] = setting;
  return { ...pins, name, env: settings, link };
}

/**
 * The folders a build machine may keep exact2 for `pins` in, under Exact's own `~/.exact/exact2`: one named by the
 * commit, then one named like the client's checkout folder.
 */
function exactCheckoutCandidates(pins: Pick<ExactPins, 'exact2' | 'checkout'>, home: string): string[] {
  return [...new Set([pins.exact2, pins.checkout])].map((name) => join(home, '.exact', 'exact2', name));
}

/** Where a build machine builds with exact2 for `pins`: the first candidate folder at the pinned commit, else the commit's. */
export function exactCheckoutDir(pins: Pick<ExactPins, 'exact2' | 'checkout'>, home: string = homedir()): string {
  return (
    exactCheckoutCandidates(pins, home).find((dir) => git(dir, ['rev-parse', 'HEAD']) === pins.exact2) ??
    join(home, '.exact', 'exact2', pins.exact2)
  );
}

function bunInstall(pin: string): string {
  return `curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun-${pin}" bash -s "bun-v${pin}"`;
}

function rustProblems(rust: string | null, rustup: string | null, env: NodeJS.ProcessEnv): ExactToolProblem[] {
  const installToolchain = `rustup toolchain install ${rust ?? 'stable'} --profile minimal --target ${EXACT_SIM_TARGET}`;
  if (!rustup)
    return [
      {
        reason: 'no rustup',
        commands: [
          "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none",
          `~/.cargo/bin/${installToolchain}`,
        ],
      },
    ];
  if (rust === null) return [];
  const targets = getExecutor().runFileQuiet(rustup, ['target', 'list', '--installed', '--toolchain', rust], {
    timeoutMs: 20_000,
    env: { ...env, RUSTUP_AUTO_INSTALL: '0' },
  });
  if (targets === null) return [{ reason: `no Rust ${rust}`, commands: [installToolchain] }];
  if (!targets.split('\n').includes(EXACT_SIM_TARGET))
    return [
      {
        reason: `no Rust ${rust} target ${EXACT_SIM_TARGET}`,
        commands: [`rustup target add --toolchain ${rust} ${EXACT_SIM_TARGET}`],
      },
    ];
  return [];
}

function setupRan(checkout: string, cargoHome: string): boolean {
  return existsSync(join(checkout, 'node_modules')) && existsSync(join(cargoHome, 'hermes-lean-sys'));
}

const shownPath = (path: string, home: string): string =>
  path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

/**
 * What keeps a build machine from building with exact2 for `pins`: no candidate folder holds the commit cleanly and set
 * up. The remedy fetches the commit from the client's remote, which may be a fork of exact2.
 */
function exact2Problem(pins: ExactPins, home: string, cargoHome: string): ExactToolProblem | null {
  const short = pins.exact2.slice(0, 10);
  const source = pins.url ?? 'https://github.com/expo/exact';
  const setup = (shown: string) => `cd ${shown} && ~/.bun-${pins.bun}/bin/bun scripts/exact.mjs setup`;
  const present = exactCheckoutCandidates(pins, home).filter((dir) => existsSync(join(dir, 'scripts', 'app-cli.mjs')));
  const ready = present.find((dir) => git(dir, ['rev-parse', 'HEAD']) === pins.exact2);
  if (!ready) {
    const dir = present.at(-1) ?? join(home, '.exact', 'exact2', pins.checkout);
    const shown = shownPath(dir, home);
    const checkout = [
      `git -C ${shown} fetch ${source} ${pins.exact2}`,
      `git -C ${shown} checkout --detach ${pins.exact2}`,
    ];
    return present.length
      ? { reason: `${shown} is not at commit ${short}`, commands: [...checkout, setup(shown)] }
      : {
          reason: `no exact2 ${short} at ${shown}`,
          commands: [`git clone ${source} ${shown}`, ...checkout, setup(shown)],
        };
  }
  const shown = shownPath(ready, home);
  if (git(ready, ['status', '--porcelain', '--untracked-files=no']) !== '')
    return {
      reason: `${shown} has local changes; Stim builds only a clean checkout of the pin`,
      commands: [`git -C ${shown} status`],
    };
  if (!setupRan(ready, cargoHome))
    return { reason: `Exact's setup has not run for exact2 ${short} at ${shown}`, commands: [setup(shown)] };
  return null;
}

export function exactToolProblems(pins: ExactPins, env: NodeJS.ProcessEnv): ExactToolProblem[] {
  const home = env.HOME ?? homedir();
  const problems: ExactToolProblem[] = [];
  const bunDir = `~/.bun-${pins.bun}`;
  const bun = join(home, `.bun-${pins.bun}`, 'bin', 'bun');
  const bunVersion = existsSync(bun) ? getExecutor().runFileQuiet(bun, ['--version'], { timeoutMs: 20_000 }) : null;
  if (bunVersion !== pins.bun)
    problems.push({
      reason: `no Bun ${pins.bun} at ${bunDir}${bunVersion ? ` (it runs ${bunVersion})` : ''}`,
      commands: [bunInstall(pins.bun)],
    });
  const cargoHome = env.CARGO_HOME ?? join(home, '.cargo');
  const rustup = join(cargoHome, 'bin', 'rustup');
  problems.push(...rustProblems(pins.rust, existsSync(rustup) ? rustup : null, env));
  const problem = exact2Problem(pins, home, cargoHome);
  if (problem) problems.push(problem);
  return problems;
}

function launcherFallbackBun(launcher: string): string {
  const fallback = /else exec ('(?:[^']|'\\'')*'|\S+) "\$0"/.exec(launcher)?.[1] ?? 'bun';
  return fallback.startsWith("'") ? fallback.slice(1, -1).replaceAll("'\\''", "'") : fallback;
}

function olderVersion(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  if (a.length < 3 || a.some((n) => !Number.isFinite(n))) return true;
  const different = b.findIndex((n, i) => n !== a[i]);
  return different >= 0 && (a[different] ?? 0) < (b[different] ?? 0);
}

/**
 * What this Mac lacks for `./exact.mjs ios` in the Exact app at `root`, found the way its launcher looks: Bun from
 * `$BUN`, then `~/.bun-<pin>`, then the launcher's fallback, at the pinned version or newer; exact2 at `EXACT2` or
 * the launcher's default, set up; and rustup with `RUSTUP_TOOLCHAIN` or the app's Rust toolchain and the simulator
 * target. Runs only `bun --version` and
 * `rustup`.
 */
export function exactLocalToolProblems(root: string, env: NodeJS.ProcessEnv): ExactToolProblem[] {
  let launcher: string;
  try {
    launcher = readFileSync(join(root, 'exact.mjs'), 'utf8');
  } catch {
    return [];
  }
  const { bun: pin, exact2Default } = exactLauncherPins(launcher);
  const exact2Path = env.EXACT2 ?? exact2Default;
  if (!pin || exact2Path === null) return [];
  const executor = getExecutor();
  const home = env.HOME ?? homedir();
  const problems: ExactToolProblem[] = [];
  let bunCommand = `~/.bun-${pin}/bin/bun`;
  const versioned = join(home, `.bun-${pin}`, 'bin', 'bun');
  const fallback = launcherFallbackBun(launcher);
  const bun =
    env.BUN ||
    (existsSync(versioned)
      ? versioned
      : fallback.includes('/')
        ? fallback
        : executor.findExecutable(fallback, { env }));
  const version = bun ? executor.runFileQuiet(bun, ['--version'], { timeoutMs: 20_000 }) : null;
  if (!bun || version === null)
    problems.push({
      reason: `no Bun ${pin} (exact.mjs runs ${env.BUN ? `$BUN (${env.BUN})` : `~/.bun-${pin}/bin/bun, else ${fallback.includes('/') ? shownPath(fallback, home) : `${fallback} on PATH`}`})`,
      commands: [bunInstall(pin)],
    });
  else if (olderVersion(version, pin))
    problems.push({
      reason: `Bun ${version} at ${shownPath(bun, home)} is older than the ${pin} exact.mjs pins`,
      commands: [bunInstall(pin), ...(env.BUN ? ['unset BUN'] : [])],
    });
  else bunCommand = shownPath(bun, home);
  const exact2Dir = resolve(root, exact2Path);
  const shown = shownPath(exact2Dir, home);
  const cargoHome = env.CARGO_HOME ?? join(home, '.cargo');
  const setup = `cd ${shown} && ${bunCommand} scripts/exact.mjs setup`;
  if (!existsSync(join(exact2Dir, 'scripts', 'app-cli.mjs'))) {
    const pinned = basename(exact2Dir);
    problems.push({
      reason: `no exact2 checkout at ${shown} (exact.mjs reads EXACT2, else ${exact2Default ?? 'nothing'}); set EXACT2 to an exact2 checkout, or clone one there`,
      commands: [
        `git clone https://github.com/expo/exact ${shown}`,
        ...(SHA.test(pinned) ? [`git -C ${shown} checkout ${pinned}`] : []),
        setup,
      ],
    });
  } else if (!setupRan(exact2Dir, cargoHome))
    problems.push({ reason: `Exact's setup has not run for the exact2 checkout at ${shown}`, commands: [setup] });
  let rust: string | null = env.RUSTUP_TOOLCHAIN ?? null;
  for (const dir of rust ? [] : [root, exact2Dir]) {
    try {
      rust = exactRustChannel(readFileSync(join(dir, 'rust-toolchain.toml'), 'utf8'));
    } catch {}
    if (rust) break;
  }
  const rustup = join(cargoHome, 'bin', 'rustup');
  problems.push(...rustProblems(rust, existsSync(rustup) ? rustup : executor.findExecutable('rustup', { env }), env));
  return problems;
}
