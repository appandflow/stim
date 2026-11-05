import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = (dir: string, pattern: RegExp): string[] =>
  readdirSync(join(root, dir))
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name));

const published = [
  ...files('fixtures', /\.(json|ndjson)$/),
  ...files('frame-sources', /\.(html|sh)$/),
  ...files('src', /\.ts$/),
];

const FORBIDDEN: [string, RegExp][] = [
  ['a real user name', /janic|duplessis/i],
  ['a real host name', /mac-?mini|\.ts\.net|\.local\b|tailscale/i],
  ['a real project name', /tlon|appandflow|app ?& ?flow/i],
  ['a physical device UDID', /\b[0-9a-f]{8}-[0-9a-f]{16}\b/i],
  ['a home path other than /Users/demo', /\/Users\/(?!demo\b)[A-Za-z]/],
  ['an email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ['a token field with a value', /"(deviceToken|pairingToken|token)"\s*:\s*"[^"]+"/],
];

const ALLOWED_URL =
  /^(https?|wss?):\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)|^https:\/\/github\.com\/example\/|^https:\/\/claude\.ai\/code\/session_demo$/;
const FICTIONAL_UUID = /^(1D0E0000|00000000)-0000-4000-8000-[0-9A-F]{12}$/;

describe('published demo data', () => {
  it.each(published)('%s has no real names, hosts, paths, device ids or tokens', (file) => {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [what, pattern] of FORBIDDEN) expect(text, `${file} contains ${what}`).not.toMatch(pattern);
    for (const url of text.match(/\b(https?|wss?):\/\/[A-Za-z0-9][^\s"'`)<\\]*/g) ?? []) {
      expect(url, `${file} links outside the fictional hosts`).toMatch(ALLOWED_URL);
    }
    for (const uuid of text.match(/\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/gi) ?? []) {
      expect(uuid, `${file} has a UUID outside the fictional range`).toMatch(FICTIONAL_UUID);
    }
  });

  it.each([...files('src', /\.ts$/), ...files('test', /\.ts$/)])('%s is ASCII-only', (file) => {
    expect([...readFileSync(join(root, file), 'utf8')].filter((char) => char.charCodeAt(0) > 0x7f)).toEqual([]);
  });
});
