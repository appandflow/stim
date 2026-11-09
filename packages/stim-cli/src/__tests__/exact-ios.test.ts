import { exactBuiltApp } from '../integrations/exact-ios.ts';

const app = '/w/app/target/clients/abc/com.example.app/ios-simulator/aarch64-apple-ios-sim/Shop.app';

test.each([
  ['an install', `host/apple: ${app} on sim-1 0C01DFC2 (cargo 2.9 s, swift 1.6 s); GPU: no GPU crate`, app],
  ['--no-install', `host/apple: ${app} (cargo 3.8 s); built and signed, installed on nothing (--no-install)`, app],
  ['a progress line', 'host/apple: no Metal toolchain, so no Canvas 2D GPU module', null],
])('reads the built app from Exact output after %s', (_, line, expected) => {
  expect(exactBuiltApp(['Compiling exact-kernel v0.1.0', line, 'Finished `host-dev` profile'])).toBe(expected);
});
