import { buildAnimationLayers } from './build-animation';

const names = [
  'pulse',
  'screen-rn',
  'screen-native',
  'item-cube-fill',
  'item-ios-fill',
  'item-android-fill',
  'item-macos-fill',
  'item-web-fill',
  'jar-body',
];
const kept = (platform: string) =>
  buildAnimationLayers(
    names.map((nm) => ({ nm })),
    platform,
  ).map(({ nm }) => nm);

test('keeps the platform item and the React Native screen for iOS and Android', () => {
  expect(kept('ios')).toEqual(['pulse', 'screen-rn', 'item-ios-fill', 'jar-body']);
  expect(kept('android')).toEqual(['pulse', 'screen-rn', 'item-android-fill', 'jar-body']);
});

test('drops every screen for macOS and web', () => {
  expect(kept('macos')).toEqual(['pulse', 'item-macos-fill', 'jar-body']);
  expect(kept('web')).toEqual(['pulse', 'item-web-fill', 'jar-body']);
});

test('falls back to the cube for an unknown platform', () => {
  expect(kept('tvos')).toEqual(['pulse', 'item-cube-fill', 'jar-body']);
});
