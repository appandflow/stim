import { parseWorkspaceLink, sharedWorkspaceURL } from '../workspace-link.ts';

const machine = '871c7262-f6bc-469a-b822-15da928350ee';
const workspace = '0123456789abcdef';
const url = `https://stim.appandflow.com/open?v=1&machine=${machine}&workspace=${workspace}`;

test('shared destinations round-trip device selectors without paths or credentials', () => {
  const destination = { machine, workspace, platform: 'macos' as const, slot: 'phone & tablet' };
  const encoded = sharedWorkspaceURL(destination);
  expect(parseWorkspaceLink(encoded)).toEqual(destination);
  expect(new URL(encoded).searchParams.get('slot')).toBe('phone & tablet');
  expect([...new URL(encoded).searchParams.keys()]).toEqual(['v', 'machine', 'workspace', 'platform', 'slot']);
  expect(parseWorkspaceLink(`${url}&slot=default`)).toEqual({ machine, workspace });
});

test('only the claimed HTTPS origin and unambiguous v1 destinations are admitted', () => {
  for (const rejected of [
    url.replace('https:', 'http:'),
    url.replace('stim.appandflow.com', 'stim.appandflow.com.evil.example'),
    url.replace('https://', 'https://user@'),
    url.replace('/open?', '/other?'),
    url.replace('v=1', 'v=2'),
    url.replace(workspace, '/Users/me/app'),
    `${url}&machine=${machine}`,
    `${url}&platform=tvos`,
  ])
    expect(parseWorkspaceLink(rejected)).toBeNull();
  expect(parseWorkspaceLink(url.replace('/open?', '/open/?'))).toEqual({ machine, workspace });
  expect(parseWorkspaceLink(`${url}&endpoint=wss://evil.example&token=secret`)).toEqual({ machine, workspace });
});
