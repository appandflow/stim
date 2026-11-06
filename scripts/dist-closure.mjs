import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));

const pluginRules = [
  ['cache provider loader', /^@stim-cli\/cache\/provider\.ts$/],
  ['cache contract', /^@stim-cli\/cache\/contract\.ts$/],
  ['agent-driver contract', /^@stim-cli\/agent-driver\/contract\.ts$/],
  ['plugin entry', /^stim\/src\/plugin\.ts$/],
];
const shared = [
  ['ws', /^ws(\/|$)/],
  ['node-datachannel', /^node-datachannel(\/|$)/],
  ['Noise', /^@stim-cli\/core\/noise/],
  ['offload/', /^stim\/src\/offload\//],
  ['device-host/', /^stim\/src\/device-host\//],
  ...pluginRules,
];
const fingerprint = ['@expo/fingerprint', /^@expo\/fingerprint(\/|$)/];
const ownFingerprint = ['fingerprint/', /^stim\/src\/fingerprint\//];
const deny = {
  cli: [...shared, ownFingerprint],
  ios: shared,
  android: shared,
  status: [...shared, fingerprint, ownFingerprint],
  'agent-device': [...shared, fingerprint, ownFingerprint],
  api: shared,
  tiers: pluginRules,
  daemon: [ownFingerprint, ...pluginRules],
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

function sourceModules(file, packages) {
  const pkg = packageOf(file, packages);
  const regions = [...readFileSync(file, 'utf8').matchAll(region)].map((match) => match[1]);
  return (regions.length > 0 ? regions : [relative(pkg.dir, file)]).flatMap((name) => {
    const source = resolve(pkg.dir, name);
    const sourcePackage = packageOf(source, packages);
    return sourcePackage.dir !== pkg.dir && relative(sourcePackage.dir, source).startsWith(`dist${sep}`)
      ? sourceModules(source, packages)
      : [`${sourcePackage.name}/${relative(sourcePackage.dir, source).split(sep).join('/')}`];
  });
}

/** tsdown names the source modules of a built file with `//#region <path>` lines. */
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
    for (const name of sourceModules(file, packages)) {
      if (!modules.has(name)) modules.set(name, path);
    }
    for (const [, specifier] of source.matchAll(staticImport)) {
      const next = specifier.startsWith('.') ? resolve(dirname(file), specifier) : resolveBare(specifier, workspace);
      if (next) queue.push([next, [...path, next]]);
      else if (!specifier.startsWith('node:') && !modules.has(specifier)) modules.set(specifier, path);
    }
  }
  return modules;
}

export function forbidden(modules, rules) {
  const hits = [];
  for (const [module, path] of modules) {
    const rule = rules.find(([, pattern]) => pattern.test(module));
    if (rule) hits.push({ rule: rule[0], module, path });
  }
  return hits;
}

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
  entries.tiers = [join(dist, '../../cache/dist/tiers.mjs')];
  const stimd = /"__stimd"\) await \(await import\("(\.\/[^"]+\.mjs)"\)\)/.exec(commands);
  if (!stimd) throw new Error(`${base[1]} loads no chunk for __stimd`);
  entries.daemon = [...base, join(dist, stimd[1]), join(dist, 'stimd-thread.mjs')];
  return entries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { enforce: { type: 'string', default: '' } } });
  const enforce = values.enforce.split(',').filter(Boolean);
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
