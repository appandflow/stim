#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const repo = join(app, '..', '..');
const output = join(app, 'src', 'generated', 'licenses.json');
const check = process.argv.includes('--check');

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

function bundledPackageRoots() {
  const dir = mkdtempSync(join(tmpdir(), 'stim-licenses-'));
  try {
    execFileSync(
      'expo',
      ['export', '--platform', 'ios', '--platform', 'android', '--source-maps', '--no-bytecode', '--output-dir', dir],
      { cwd: app, env: { ...process.env, APP_VARIANT: 'production', CI: '1' }, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const roots = new Set();
    for (const platform of ['ios', 'android']) {
      const jsDir = join(dir, '_expo', 'static', 'js', platform);
      const map = readdirSync(jsDir).find((name) => name.endsWith('.map'));
      const { sections } = read(join(jsDir, map));
      for (const { map: section } of sections) {
        for (const source of section.sources) {
          const marker = source.lastIndexOf('node_modules/');
          if (marker === -1) continue;
          const [first, second] = source.slice(marker + 'node_modules/'.length).split('/');
          const name = first.startsWith('@') ? `${first}/${second}` : first;
          roots.add(source.slice(0, marker + 'node_modules/'.length + name.length));
        }
      }
    }
    return [...roots].map((root) => join(repo, root));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function directDependencyRoots() {
  return Object.keys(read(join(app, 'package.json')).dependencies).map((name) =>
    realpathSync(join(app, 'node_modules', name)),
  );
}

function licenseId(pkg) {
  const value = pkg.license ?? pkg.licenses;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => item.type ?? item).join(' OR ');
  return value?.type ?? 'Unknown';
}

function repositoryUrl(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) return null;
  const url = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (/^https?:\/\//.test(url)) return url;
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : null;
}

function licenseText(root) {
  const file = readdirSync(root)
    .filter((name) => /^(licen[cs]e|copying)(\.|$|-)/i.test(name))
    .sort()[0];
  if (!file) return null;
  const text = readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n').trim();
  return text || null;
}

function generate() {
  const roots = [...new Set([...bundledPackageRoots(), ...directDependencyRoots()])];
  const texts = [];
  const textIndex = new Map();
  const indexOf = (text) => {
    if (text === null) return null;
    if (!textIndex.has(text)) textIndex.set(text, texts.push(text) - 1);
    return textIndex.get(text);
  };

  const stim = { name: 'Stim', version: read(join(app, 'package.json')).version, license: 'MIT' };
  const packages = [
    {
      ...stim,
      url: 'https://github.com/appandflow/stim',
      text: indexOf(readFileSync(join(repo, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim()),
    },
  ];
  const entries = new Map();
  for (const root of roots) {
    const pkg = read(join(root, 'package.json'));
    entries.set(`${pkg.name}@${pkg.version}`, {
      name: pkg.name,
      version: pkg.version,
      license: licenseId(pkg),
      url: repositoryUrl(pkg) ?? (pkg.homepage?.startsWith('http') ? pkg.homepage : null),
      text: licenseText(root),
    });
  }
  const byRepository = new Map();
  for (const entry of entries.values()) {
    if (entry.text && entry.url) byRepository.set(`${entry.url} ${entry.license}`, entry.text);
  }
  for (const entry of entries.values()) {
    entry.text ??= byRepository.get(`${entry.url} ${entry.license}`) ?? null;
  }
  const sorted = [...entries.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version),
  );
  for (const entry of sorted) packages.push({ ...entry, text: indexOf(entry.text) });

  const json = JSON.stringify({ packages, texts }, null, 1).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${json}\n`;
}

const next = generate();
if (check) {
  const current = existsSync(output) ? readFileSync(output, 'utf8') : '';
  if (current !== next) {
    console.error('src/generated/licenses.json is out of date. Run `pnpm run licenses` in apps/mobile and commit it.');
    process.exit(1);
  }
} else {
  writeFileSync(output, next);
  console.log(`Wrote ${output}`);
}
