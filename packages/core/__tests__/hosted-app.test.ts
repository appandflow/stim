import { parseHostedAppManifest } from '../state/hosted-app.ts';

const file = (path: string, kind = 'file') => ({ path, kind, size: 1, sha256: 'a'.repeat(64) });

test('rejects traversal, aliases and entries below a file or link before any bundle materialization', () => {
  for (const paths of [
    ['Info.plist', '../escape'],
    ['Info.plist', '/absolute'],
    ['Info.plist', 'resources/./value'],
    ['Info.plist', 'INFO.plist'],
    ['Info.plist', 'Resources', 'resources/value'],
  ])
    expect(parseHostedAppManifest(paths.map((path) => file(path)))).toBeNull();
  expect(
    parseHostedAppManifest([file('Info.plist'), file('Frameworks/Current', 'link'), file('Frameworks/Current/binary')]),
  ).toBeNull();
  expect(parseHostedAppManifest([file('Resources/value'), file('Info.plist')])?.map((each) => each.path)).toEqual([
    'Info.plist',
    'Resources/value',
  ]);
});
