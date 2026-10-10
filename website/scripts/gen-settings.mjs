import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../../packages/core/state/settings-registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'docs', '_generated');

// This site parses .md as MDX, which reads `<` and `{` as JSX outside a code
// span. A `|` would end a table cell, inside a code span or not.
const escapeCell = (text) =>
  text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replaceAll('<', '&lt;').replaceAll('{', '&#123;')))
    .join('')
    .replaceAll('|', '\\|');

const code = (value) => `\`${value}\``;

function typeText(type) {
  switch (type.kind) {
    case 'boolean':
      return 'boolean';
    case 'string':
      return type.patternHelp ? `string: ${type.patternHelp}` : 'string';
    case 'path':
      return type.absolute ? 'absolute path' : type.relative ? 'path relative to the app' : 'path';
    case 'strings':
      return 'string array';
    case 'number': {
      const noun = type.integer ? 'integer' : 'number';
      if (type.minimum !== undefined && type.maximum !== undefined) return `${noun} ${type.minimum}..${type.maximum}`;
      if (type.exclusiveMinimum !== undefined) return `${noun} > ${type.exclusiveMinimum}`;
      if (type.minimum !== undefined) return `${noun} >= ${type.minimum}`;
      return noun;
    }
    case 'choice':
      return type.choices.map(code).join(', ');
    case 'object':
      return 'object';
    case 'bundle-url':
      return 'bundle URL';
  }
}

function defaultText(setting) {
  const parts = [setting.default === undefined ? 'unset' : code(JSON.stringify(setting.default).replace(/^"|"$/g, ''))];
  if (setting.desktopDefault !== undefined) parts.push(`${code(setting.desktopDefault)} with Stim Desktop installed`);
  if (setting.scopedHomeValue !== undefined) parts.push(`${code(setting.scopedHomeValue)} under \`STIM_HOME\``);
  if (setting.ciValue !== undefined) parts.push(`${code(setting.ciValue)} under \`CI\``);
  return parts.join('; ');
}

function layersText(setting) {
  return setting.scopes
    .map((scope) =>
      scope === 'committed' && setting.committedAt === 'repository' ? 'committed (repository root)' : scope,
    )
    .join(', ');
}

function settingsTable(settings) {
  const rows = settings.map((setting) =>
    [
      code(setting.key),
      typeText(setting.type),
      layersText(setting),
      defaultText(setting),
      setting.env ? code(setting.env) : '',
      setting.description,
    ].map(escapeCell),
  );
  return table(['Key', 'Type', 'Layers', 'Default', 'Environment override', 'Description'], rows);
}

function envTable(settings) {
  const rows = settings
    .filter((setting) => setting.env)
    .toSorted((a, b) => a.env.localeCompare(b.env))
    .map((setting) => [code(setting.env), code(setting.key), setting.description].map(escapeCell));
  return table(['Variable', 'Overrides', 'Description'], rows);
}

const table = (header, rows) =>
  [header, header.map(() => '---'), ...rows].map((cells) => `| ${cells.join(' | ')} |`).join('\n') + '\n';

const isMaintenance = (setting) => setting.key.startsWith('maintenance.') || /^caches\..*MaxGb$/.test(setting.key);

const GROUPS = [
  ['archive', (setting) => setting.key.startsWith('archive.')],
  ['maintenance', isMaintenance],
  ['budget', (setting) => setting.key.startsWith('budget.')],
  ['project', (setting) => setting.scopes.some((scope) => scope !== 'machine')],
  ['machine', () => true],
];

export function buildSettingsTables(settings) {
  const files = Object.fromEntries(GROUPS.map(([name]) => [`settings-${name}.md`, []]));
  for (const setting of settings) {
    const [name] = GROUPS.find(([, claims]) => claims(setting));
    files[`settings-${name}.md`].push(setting);
  }
  return {
    ...Object.fromEntries(Object.entries(files).map(([file, group]) => [file, settingsTable(group)])),
    'settings-env.md': envTable(settings),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(outDir, { recursive: true });
  const files = buildSettingsTables(SETTINGS);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(outDir, file), content);
  console.log(`settings: ${SETTINGS.length} settings -> docs/_generated/ (${Object.keys(files).length} tables)`);
}
