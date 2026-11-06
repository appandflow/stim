import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const shared = [
  ['ws', /^ws(\/|$)/],
  ['node-datachannel', /^node-datachannel(\/|$)/],
  ['Noise', /^@stim-cli\/core\/noise/],
  ['offload/', /^stim\/src\/offload\//],
  ['device-host/', /^stim\/src\/device-host\//],
  ['cache provider loader', /^@stim-cli\/cache\/provider\.ts$/],
  ['cache contract', /^@stim-cli\/cache\/contract\.ts$/],
];
const fingerprint = ['@expo/fingerprint', /^@expo\/fingerprint(\/|$)/];
const deny = {
  cli: shared,
  ios: shared,
  android: shared,
  status: [...shared, fingerprint],
  'agent-device': [...shared, fingerprint],
  api: shared,
};

const staticImport = /^(?:import|export)\s(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/gm;
const region = /^\/\/#region (\S+)/gm;

function packageOf(file, cache) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (cache.has(dir)) return cache.get(dir);
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const found = { dir, name: JSON.parse(readFileSync(manifest, 'utf8')).name };
      cache.set(dir, found);
      return found;
    }
  }
  throw new Error(`No package.json above ${file}`);
}

/** Workspace packages by name, so a bare `@stim-cli/*` import is walked into that package's built files. */
export function workspacePackages(packagesDir) {
  const found = new Map();
  for (const name of readdirSync(packagesDir)) {
    const manifest = join(packagesDir, name, 'package.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      found.set(json.name, { dir: join(packagesDir, name), exports: json.exports });
    }
  }
  return found;
}

function resolveBare(specifier, workspace) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const pkg = workspace.get(name);
  if (!pkg) return null;
  const target = pkg.exports?.[`.${specifier.slice(name.length)}`];
  const file = typeof target === 'string' ? target : target?.default;
  if (!file) throw new Error(`${name} exports no ${specifier}`);
  return join(pkg.dir, file);
}

/**
 * Every module a set of entry files loads through static imports, never through `import()`. Built files name their
 * source modules with tsdown's `//#region <path>` lines; a module is `<package name>/<path>`. Imports of packages
 * outside the workspace are recorded by specifier and not walked. Each module maps to the file chain that loads it.
 */
export function staticClosure(entries, workspace) {
  const packages = new Map();
  const chain = new Map();
  const modules = new Map();
  const queue = entries.map((file) => [file, [file]]);
  while (queue.length > 0) {
    const [file, path] = queue.shift();
    if (chain.has(file)) continue;
    chain.set(file, path);
    const source = readFileSync(file, 'utf8');
    const pkg = packageOf(file, packages);
    const regions = [...source.matchAll(region)].map((match) => match[1]);
    for (const name of regions.length > 0 ? regions : [relative(pkg.dir, file)]) {
      if (!modules.has(`${pkg.name}/${name}`)) modules.set(`${pkg.name}/${name}`, path);
    }
    for (const [, specifier] of source.matchAll(staticImport)) {
      const next = specifier.startsWith('.') ? resolve(dirname(file), specifier) : resolveBare(specifier, workspace);
      if (next) queue.push([next, [...path, next]]);
      else if (!specifier.startsWith('node:') && !modules.has(specifier)) modules.set(specifier, path);
    }
  }
  return modules;
}

/** The modules of a closure that a deny list forbids, each with its rule label and the file chain that loads it. */
export function forbidden(modules, rules) {
  const hits = [];
  for (const [module, path] of modules) {
    const rule = rules.find(([, pattern]) => pattern.test(module));
    if (rule) hits.push({ rule: rule[0], module, path });
  }
  return hits;
}

/** The files each checked entry starts from: `--version` loads `cli.mjs` and the chunk it imports. */
export function entryFiles(dist) {
  const cli = join(dist, 'cli.mjs');
  const main = /import\("(\.\/cli-[^"]+\.mjs)"\)/.exec(readFileSync(cli, 'utf8'));
  if (!main) throw new Error(`${cli} imports no cli-*.mjs chunk`);
  const base = [cli, join(dist, main[1])];
  const commands = readFileSync(base[1], 'utf8');
  const entries = { cli: base };
  for (const name of ['ios', 'android', 'status', 'agent-device']) {
    const chunk = new RegExp(`\\["${name}", \\(\\) => import\\("(\\./[^"]+\\.mjs)"\\)\\]`).exec(commands);
    if (!chunk) throw new Error(`${base[1]} loads no chunk for the ${name} command`);
    entries[name] = [...base, join(dist, chunk[1])];
  }
  entries.api = [join(dist, 'api.mjs')];
  return entries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--enforce');
  const enforce = at > 0 ? process.argv[at + 1].split(',') : [];
  const unknown = enforce.filter((name) => !deny[name]);
  if (unknown.length > 0) throw new Error(`Unknown entry for --enforce: ${unknown.join(', ')}`);
  const dist = join(root, 'packages/stim-cli/dist');
  const workspace = workspacePackages(join(root, 'packages'));
  const short = (file) => relative(dist, file).replace(/^(\.\.\/)+/, '');
  let failed = false;
  for (const [name, files] of Object.entries(entryFiles(dist))) {
    const modules = staticClosure(files, workspace);
    const hits = forbidden(modules, deny[name]);
    const mode = enforce.includes(name) ? 'enforced' : 'report';
    console.log(`${name} (${mode}): ${modules.size} modules, ${hits.length} forbidden`);
    for (const hit of hits) console.log(`  ${hit.rule}: ${hit.module} via ${hit.path.map(short).join(' > ')}`);
    if (hits.length > 0 && mode === 'enforced') failed = true;
  }
  if (failed) {
    console.error(
      'An enforced closure loads a forbidden module. Load it with await import() in the branch that needs it.',
    );
    process.exit(1);
  }
}
