import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { stimBuildDigest } from '@stim-cli/core/state';
import { lastLines, ServiceError, signatureProblem, type ServerBuild } from './service-plist.ts';
import { run } from './service-manager.ts';

export type UpdateSource = { release: string } | { from: string };

const NPM_TIMEOUT_MS = 10 * 60_000;
const REGISTRY = 'https://registry.npmjs.org/';
const SERVER_PACKAGE = 'stim';
const SERVER_SCRIPT = ['node_modules', 'stim', 'bin', 'stim.mjs'];

export function stimDist(from: string): string | null {
  try {
    const manifest = createRequire(from).resolve('stim/package.json');
    return join(dirname(manifest), 'dist');
  } catch {
    return null;
  }
}

export function serverBuild(script: string): ServerBuild | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(script), '..', 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version !== 'string') return null;
    const dist = stimDist(script);
    return { version: pkg.version, stimBuild: dist ? stimBuildDigest(dist) : null };
  } catch {
    return null;
  }
}

/**
 * How to run npm for `node`. On Windows npm is a `.cmd` shim, which Node runs only through a shell, so this runs its
 * `npm-cli.js` with `node` instead.
 */
function npmFor(node: string): { npm: string; prefix: string[]; env: NodeJS.ProcessEnv } {
  const path = [dirname(node), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
  const env = { ...process.env, PATH: path.join(delimiter) };
  for (const dir of path) {
    if (process.platform === 'win32') {
      const cli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (existsSync(cli)) return { npm: node, prefix: [cli], env };
      continue;
    }
    const npm = join(dir, 'npm');
    if (existsSync(npm)) return { npm, prefix: [], env };
  }
  throw new ServiceError(`No npm next to ${node} or on PATH. Install npm for that node, then run update again.`);
}

function installedIntegrity(staging: string): string | null {
  try {
    const lock = JSON.parse(readFileSync(join(staging, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { integrity?: unknown }>;
    };
    const integrity = lock.packages?.[`node_modules/${SERVER_PACKAGE}`]?.integrity;
    return typeof integrity === 'string' ? integrity : null;
  } catch {
    return null;
  }
}

/**
 * The uploaded package files by package name, as `file:` specs. npm `audit signatures` skips a node only when its
 * dependent's spec is a file spec (npm lib/utils/verify-signatures.js), so the staging project lists every uploaded
 * package as a direct dependency and overrides every edge to it with `$name`.
 */
async function localPackageSpecs(dir: string, names: string[]): Promise<Record<string, string>> {
  const specs: Record<string, string> = {};
  for (const file of names) {
    const path = join(dir, file);
    const manifest = await run(
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : '/usr/bin/tar',
      ['-xzOf', path, 'package/package.json'],
      process.env,
      60_000,
    );
    let name: unknown;
    try {
      name = (JSON.parse(manifest.stdout) as { name?: unknown }).name;
    } catch {
      name = null;
    }
    if (!manifest.ok || typeof name !== 'string' || !name) {
      throw new ServiceError(
        `${path} is not an npm package file.${manifest.ok ? '' : `\n${lastLines(manifest.stderr)}`}`,
      );
    }
    if (specs[name]) throw new ServiceError(`${dir} has more than one package file for ${name}.`);
    specs[name] = `file:${path}`;
  }
  return specs;
}

export async function installServer(
  versions: string,
  source: UpdateSource,
  node: string,
  log: (line: string) => void,
  npmOptions: readonly string[] = [],
): Promise<{ script: string; build: ServerBuild; dir: string }> {
  mkdirSync(versions, { recursive: true });
  for (const entry of readdirSync(versions)) {
    if (entry.startsWith('.install-')) rmSync(join(versions, entry), { recursive: true, force: true });
  }
  const staging = join(versions, `.install-${process.pid}`);
  mkdirSync(staging);
  try {
    const { npm, prefix, env } = npmFor(node);
    const registry = [`--registry=${REGISTRY}`, `--@stim-cli:registry=${REGISTRY}`];
    let files: { name: string; sha256: string }[] = [];
    let specs: string[];
    let localPackages: Record<string, string> | null = null;
    if ('release' in source) {
      specs = [`${SERVER_PACKAGE}@${source.release}`];
    } else {
      const names = readdirSync(source.from).filter((name) => name.endsWith('.tgz'));
      if (!names.length) throw new ServiceError(`${source.from} has no .tgz package files.`);
      files = names.map((name) => ({
        name,
        sha256: createHash('sha256')
          .update(readFileSync(join(source.from, name)))
          .digest('hex'),
      }));
      specs = [];
      localPackages = await localPackageSpecs(source.from, names);
    }
    const overrides = localPackages && Object.fromEntries(Object.keys(localPackages).map((name) => [name, `$${name}`]));
    const project = localPackages ? { private: true, dependencies: localPackages, overrides } : { private: true };
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(project, null, 2)}\n`);
    log(
      `Installing ${'release' in source ? `${SERVER_PACKAGE}@${source.release} from ${REGISTRY}` : `${files.length} package file(s) from ${source.from}`}.`,
    );
    // npm 10 on Windows fails to save the root package.json of a project that only lists `file:` packages
    // (TypeError reading 'spec' in arborist's reify), and with a working directory outside the project it looks
    // for a package.json there; nothing needs saving, and npm runs from the project.
    const installed = await run(
      npm,
      [
        ...prefix,
        'install',
        '--prefix',
        staging,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        ...(localPackages && process.platform === 'win32' ? ['--no-save'] : ['--save-exact']),
        ...npmOptions,
        ...registry,
        ...specs,
      ],
      env,
      NPM_TIMEOUT_MS,
      process.platform === 'win32' ? staging : undefined,
    );
    if (!installed.ok) throw new ServiceError(`npm install failed:\n${lastLines(installed.stderr)}`);
    const audit = await run(
      npm,
      [...prefix, 'audit', 'signatures', '--json', '--prefix', staging, ...npmOptions, ...registry],
      env,
      NPM_TIMEOUT_MS,
      process.platform === 'win32' ? staging : undefined,
    );
    const problem = signatureProblem(audit.stdout, audit.stderr);
    if (problem) throw new ServiceError(`${problem}. Not switching to it.`);
    const script = join(staging, ...SERVER_SCRIPT);
    const build = existsSync(script) ? serverBuild(script) : null;
    const serverDigest = existsSync(script) ? stimBuildDigest(join(dirname(script), '..', 'dist')) : null;
    if (!build?.stimBuild || !serverDigest) {
      throw new ServiceError(`The install has no ${SERVER_PACKAGE} with its stim build.`);
    }
    if ('release' in source && build.version !== source.release) {
      throw new ServiceError(`npm installed ${SERVER_PACKAGE} ${build.version}, not ${source.release}.`);
    }
    if (!/^[0-9A-Za-z.+-]+$/.test(build.version)) {
      throw new ServiceError(`${SERVER_PACKAGE} has an unusable version "${build.version}".`);
    }
    const started = await run(node, [script, '--version'], env, 60_000);
    if (!started.ok || started.stdout.trim() !== build.version) {
      throw new ServiceError(`The installed stim-server does not run with ${node}:\n${lastLines(started.stderr)}`);
    }
    writeFileSync(
      join(staging, 'install.json'),
      `${JSON.stringify(
        {
          version: build.version,
          stimBuild: build.stimBuild,
          serverBuild: serverDigest,
          ...('release' in source
            ? { release: source.release, registry: REGISTRY, integrity: installedIntegrity(staging) }
            : { files }),
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    const filesDigest = files.length
      ? createHash('sha256')
          .update(
            files
              .map((file) => file.sha256)
              .toSorted()
              .join('\n'),
          )
          .digest('hex')
          .slice(0, 16)
      : null;
    const dir = join(
      versions,
      [build.version, build.stimBuild, serverDigest, ...(filesDigest ? [filesDigest] : [])].join('-'),
    );
    if (!existsSync(dir)) renameSync(staging, dir);
    return { script: join(dir, ...SERVER_SCRIPT), build, dir };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
