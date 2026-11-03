import { accessFor, cleanName, digest, guestName, viewerColor } from '../src/share-identity.ts';

const control = digest('control password');
const view = digest('view password');

test('a password gives the access of the digest it matches, and nothing else gives any', () => {
  expect(accessFor('control password', control, view)).toBe('control');
  expect(accessFor('view password', control, view)).toBe('view');
  expect(accessFor('other', control, view)).toBeNull();
  expect(accessFor('', control, view)).toBeNull();
});

test('a share without a view password matches only its control one, whatever the empty digest would match', () => {
  expect(accessFor('control password', control, null)).toBe('control');
  expect(accessFor('view password', control, null)).toBeNull();
  expect(accessFor(String.fromCharCode(0).repeat(32), control, null)).toBeNull();
});

test('names are cleaned for display: NFC, no control or bidi characters, collapsed whitespace, 24 code points', () => {
  expect(cleanName('  Ann \t Lee ')).toBe('Ann Lee');
  expect(cleanName('é')).toBe('é');
  expect(cleanName('A‮B\u0007C')).toBe('A B C');
  expect(cleanName('x'.repeat(40))).toBe('x'.repeat(24));
  expect(cleanName('\u{1F600}'.repeat(30))).toBe('\u{1F600}'.repeat(24));
  for (const empty of ['', '   ', '‮​', 7, null, undefined]) expect(cleanName(empty)).toBeNull();
});

test('guests are numbered from the lowest number free, and colors skip the host and agent palette slots', () => {
  expect(guestName([])).toBe('Guest 1');
  expect(guestName(['Guest 1', 'Guest 3', 'Ann'])).toBe('Guest 2');
  expect(viewerColor([])).toBe(2);
  expect(viewerColor([2, 3, 5])).toBe(4);
  expect(viewerColor([2, 3, 4, 5, 6, 7])).toBe(2);
});
