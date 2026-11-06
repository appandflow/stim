import { pickUpdateVersion, type Packument } from '../offload/update-version.ts';
import packument from './fixtures/update-packument.json' with { type: 'json' };

test.each<{ channel: 'latest' | 'next'; peer: number; expected: string | null }>([
  { channel: 'latest', peer: 2, expected: '1.42.0' },
  { channel: 'next', peer: 2, expected: '1.43.0-next.10' },
  { channel: 'latest', peer: 3, expected: null },
  { channel: 'next', peer: 4, expected: null },
])('selects $channel for peer $peer without crossing the channel', ({ channel, peer, expected }) => {
  expect(pickUpdateVersion(packument, channel, peer)).toBe(expected);
});

test('uses an older compatible version when the channel tip reports a lower peer', () => {
  const changed = structuredClone(packument);
  changed.versions['1.43.0-next.10'].peer = 1;
  expect(pickUpdateVersion(changed, 'next', 2)).toBe('1.43.0-next.9');
});

test('assumes only the channel tip is compatible when npm publishes no peer metadata', () => {
  const unknown: Packument = {
    'dist-tags': packument['dist-tags'],
    versions: Object.fromEntries(Object.keys(packument.versions).map((version) => [version, {}])),
  };
  expect(pickUpdateVersion(unknown, 'next', 2)).toBe('1.43.0-next.10');
  unknown.versions['1.43.0-next.10'] = { peer: 1 };
  expect(pickUpdateVersion(unknown, 'next', 2)).toBeNull();
});

test('refuses an empty channel instead of taking a release from the other channel', () => {
  expect(pickUpdateVersion({ ...packument, 'dist-tags': { latest: '1.42.0' } }, 'next', 2)).toBeNull();
});
