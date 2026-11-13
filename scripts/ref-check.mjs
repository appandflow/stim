/*
 * Port of ccheever/llp ref-check v0.5.2.
 *
 * MIT License
 *
 * Copyright (c) 2026 Charlie Cheever
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { parseArgs, TextDecoder } from 'node:util';

const FIELDS = ['Type', 'Status', 'Systems', 'Author', 'Date'];
const MAX_BYTES = 2_000_000;
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.idea',
  '.vscode',
]);
const SKIP_LLP = new Set(['reviews', 'current', 'foundation']);
const DOC_NAME = /^(\d{4})-[a-z0-9-]+\.([a-z0-9]+)\.md$/;
const FIELD = /^\*\*(\w+):\*\*\s*(.+)$/;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const LLP_TARGET = /^LLP\s+(\d{1,4})(?:#(\S+))?$/;
const SHORTHAND = /^[A-Z][A-Z0-9_]*(?:#\S+)?$/;
const URL = /^https?:\/\/[^\s/]+\.[^\s/]+\S*$/;
const REF = '@ref';
const CODE_REF = new RegExp(REF + '\\s+(.+)');
const MD_REF = new RegExp('<!--\\s*' + REF + '\\s+(.+?)-->', 'gs');
const decoder = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });
const lines = (text) => text.split(/\r\n?|\n/);

function readText(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return decoder.decode(readFileSync(path));
  } catch {
    return null;
  }
}

function headings(text) {
  let fenced = false;
  return lines(text).flatMap((line) => {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      return [];
    }
    if (fenced) return [];
    const heading = HEADING.exec(line)?.[1];
    return heading ? [heading] : [];
  });
}

function hasAnchor(anchor, sections) {
  const key = anchor.replace(/^#+/, '').toLowerCase();
  return sections.some((section) => {
    const slug = section
      .trim()
      .toLowerCase()
      .replace(/[ \t]/g, '-')
      .replace(/[^\p{L}\p{N}_-]/gu, '');
    return (
      slug === key ||
      (/^\d+(?:\.\d+)*$/.test(key) &&
        section.startsWith(key) &&
        (section.length === key.length || /[.)\s]/.test(section[key.length])))
    );
  });
}

function entries(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split('\0').filter((path) => path && !path.endsWith('/')))].toSorted();
}

function references(path, text) {
  if (path.endsWith('.md'))
    return [...text.matchAll(MD_REF)].map((match) => [lines(text.slice(0, match.index)).length, match[1]]);
  return lines(text).flatMap((line, at) => {
    const body = CODE_REF.exec(line)?.[1];
    return body ? [[at + 1, body]] : [];
  });
}

function checkRef(raw, docs, root) {
  const target = raw
    .trim()
    .split(/\s+[\u2013\u2014]|\s+--\s/)[0]
    .replace(/\s*\[[a-z-]+\]\s*$/, '')
    .trim();
  const numbered = LLP_TARGET.exec(target);
  if (numbered) {
    const number = numbered[1].padStart(4, '0');
    const doc = docs.get(number);
    if (!doc) return { error: `broken ref: LLP ${number} not found under llp/` };
    if (numbered[2] && !hasAnchor(numbered[2], doc.sections))
      return { error: `broken ref: no anchor #${numbered[2]} in ${doc.path}` };
    return {};
  }
  const token = target.split(/\s+/)[0];
  if (token === 'LLP') return { error: `malformed LLP target: '${target}' (expected LLP NNNN[#anchor])` };
  if (/^https?:\/\//.test(token)) return URL.test(token) ? {} : { error: `malformed URL target: ${token}` };
  if (SHORTHAND.test(token)) return { info: `unchecked shorthand: ${token} (no mapping defined)` };
  const hash = token.indexOf('#');
  const path = hash < 0 ? token : token.slice(0, hash);
  const anchor = hash < 0 ? '' : token.slice(hash + 1);
  const file = isAbsolute(path) ? path : `${root}${sep}${path}`;
  if (!existsSync(file)) return { error: `broken ref: path not found: ${path}` };
  if (!anchor) return {};
  if (!path.endsWith('.md')) return { info: `anchor #${anchor} unchecked (non-markdown target)` };
  if (!hasAnchor(anchor, headings(readText(file) ?? '')))
    return { error: `broken ref: no anchor #${anchor} in ${path}` };
  return {};
}

function check(root) {
  const docs = new Map();
  const errors = [];
  const info = [];
  const files = [];
  const listed = entries(root);
  const nested = new Set();
  for (const path of listed) {
    const dirs = path.split('/').slice(0, -1);
    for (const [index, dir] of dirs.entries()) {
      if (index > 0 && dir === 'llp') nested.add(dirs.slice(0, index).join('/'));
    }
  }
  for (const path of listed) {
    const parts = path.split('/');
    const name = parts.pop();
    if (parts.some((dir, index) => SKIP_DIRS.has(dir) || nested.has(parts.slice(0, index + 1).join('/')))) continue;
    if (parts[0] === 'llp' && SKIP_LLP.has(parts[1])) continue;
    if (name.endsWith('.json')) continue;
    const text = readText(resolve(root, path));
    if (text === null) continue;
    files.push({ path, text });
    const doc = parts[0] === 'llp' && DOC_NAME.exec(name);
    if (!doc) continue;
    const [, number, type] = doc;
    if (docs.has(number)) errors.push(`${path}: duplicate LLP number ${number} (also ${docs.get(number).path})`);
    else docs.set(number, { path, sections: headings(text) });
    const fields = new Map();
    for (const line of lines(text).slice(1, 40)) {
      const field = FIELD.exec(line.trim());
      if (field && !fields.has(field[1])) fields.set(field[1], field[2]);
    }
    for (const field of FIELDS)
      if (!fields.has(field)) errors.push(`${path}: missing required metadata field **${field}:**`);
    const docType = fields.get('Type');
    if (docType && docType.split(/\s+/)[0].toLowerCase() !== type)
      errors.push(`${path}: filename type '.${type}.md' != **Type:** ${docType}`);
  }

  let count = 0;
  for (const { path, text } of files)
    for (const [line, body] of references(path, text)) {
      count++;
      const result = checkRef(body, docs, root);
      if (result.error) errors.push(`${path}:${line}: ${result.error}`);
      if (result.info) info.push(`${path}:${line}: ${result.info}`);
    }
  return { docs: docs.size, files: files.length, refs: count, errors, info };
}

function main() {
  const { values } = parseArgs({
    options: { root: { type: 'string', default: '.' }, verbose: { type: 'boolean', default: false } },
  });
  const result = check(resolve(values.root));
  for (const error of result.errors) console.log(`ERROR ${error}`);
  if (values.verbose) for (const message of result.info) console.log(`INFO  ${message}`);
  const status = result.errors.length ? 'FAIL' : 'ok';
  console.log(
    `ref-check: ${status} — ${result.docs} LLP docs, ${result.refs} refs in ${result.files} files, ${result.errors.length} errors, ${result.info.length} unchecked`,
  );
  process.exitCode = Number(Boolean(result.errors.length));
}

main();
