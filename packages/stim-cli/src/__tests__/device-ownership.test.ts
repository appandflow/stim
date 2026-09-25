import { ownedSimName, parkedSimName } from '../devices/ios.ts';
import { isOwnedSimName } from '../devices/device-ownership.ts';

test.each([
  ownedSimName('wide-split-layout-tlon-mobile', { model: 'iPad mini (A17 Pro)', runtime: '27.0' }),
  ownedSimName('app', { model: 'iPhone 17 Pro', runtime: '26.5.1' }, ' 1a2b3c-1'),
  ownedSimName('a'.repeat(80), { model: 'iPad Pro 13-inch (M5)', runtime: '27.0' }),
  parkedSimName('ABCD-1234', { model: 'iPhone Duo', runtime: '27.1' }),
])('names Stim generates match the owned format: %s', (name) => {
  expect(isOwnedSimName(name)).toBe(true);
});

test.each(['stim-desktop-duo-test', 'stim-app', 'stim- (iPhone 17 26.5)', 'My stim-app (iPhone 17 26.5)'])(
  'other names do not: %s',
  (name) => {
    expect(isOwnedSimName(name)).toBe(false);
  },
);
