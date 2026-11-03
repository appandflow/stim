#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const DEFAULT_KEEP_NEXT = 5;

function field(xml, name) {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1].trim();
}

export function parseItems(xml) {
  return [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].map(([text]) => ({
    text,
    version: field(text, 'sparkle:shortVersionString'),
    build: Number(field(text, 'sparkle:version')),
    channel: field(text, 'sparkle:channel') ?? '',
  }));
}

function render(items, link) {
  const body = items.map(({ text }) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `${line === '<item>' || line === '</item>' ? '    ' : '      '}${line}`)
      .join('\n'),
  );
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Stim Desktop</title>
    <link>${link}</link>
${body.join('\n')}
  </channel>
</rss>
`;
}

/**
 * Adds one item to an appcast. The appcast keeps the newest stable item, which has no channel, and
 * the newest `keep` items of the `next` channel that are newer than that stable build.
 */
export function mergeAppcast({ current = '', item, link, keep = DEFAULT_KEEP_NEXT }) {
  const [added, ...extra] = parseItems(item);
  if (!added || extra.length > 0 || !added.version || !Number.isInteger(added.build)) {
    throw new Error(
      'The new appcast item must be one <item> with sparkle:shortVersionString and an integer sparkle:version',
    );
  }
  if (added.channel !== '' && added.channel !== 'next') {
    throw new Error(`Unknown Sparkle channel ${added.channel}`);
  }
  const items = [...parseItems(current).filter((old) => old.version !== added.version), added].filter(
    (entry) => Number.isInteger(entry.build) && entry.version,
  );
  const stable = items
    .filter((entry) => entry.channel === '')
    .toSorted((a, b) => b.build - a.build)
    .slice(0, 1);
  const newest = stable[0]?.build ?? -Infinity;
  const next = items
    .filter((entry) => entry.channel === 'next' && entry.build > newest)
    .toSorted((a, b) => b.build - a.build)
    .slice(0, keep);
  return render([...stable, ...next], link);
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      current: { type: 'string' },
      item: { type: 'string' },
      link: { type: 'string' },
      out: { type: 'string' },
      keep: { type: 'string', default: String(DEFAULT_KEEP_NEXT) },
    },
  });
  const [command] = positionals;
  const current = values.current ? readFileSync(values.current, 'utf8') : '';
  if (command === 'list') {
    for (const entry of parseItems(current)) {
      process.stdout.write(`${entry.channel || 'stable'}\t${entry.build}\t${entry.version}\n`);
    }
    return;
  }
  if (command === 'merge' && values.item && values.link && values.out) {
    const keep = Number(values.keep);
    if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a positive integer');
    writeFileSync(
      values.out,
      mergeAppcast({ current, item: readFileSync(values.item, 'utf8'), link: values.link, keep }),
    );
    return;
  }
  throw new Error(
    'usage: desktop-appcast.mjs list --current <file> | merge [--current <file>] --item <file> --link <url> --out <file> [--keep <n>]',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
