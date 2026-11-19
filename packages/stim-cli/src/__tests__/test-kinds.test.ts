import { namedKinds, scriptRunsKinds } from '../engine/test-kinds.ts';

test.each([
  { words: ['js'], expected: { kinds: ['js'] } },
  {
    words: ['e2e', 'js', 'e2e-ios'],
    expected: { kinds: ['e2e-ios', 'e2e-android', 'js'] },
    why: 'e2e stands for both e2e kinds, the order given is kept and repeats are dropped',
  },
  { words: ['js', 'npx', 'jest'], expected: { unknown: 'npx' }, why: 'a command word is not a kind' },
  { words: ['JS'], expected: { unknown: 'JS' }, why: 'kind names are exact' },
])('namedKinds($words)', ({ words, expected }) => {
  expect(namedKinds(words)).toEqual(expected);
});

test.each([
  { script: 'jest --ci', expected: {} },
  {
    script: 'jest && detox test -c ios.sim.debug',
    expected: { 'e2e-ios': 'detox', 'e2e-android': 'detox' },
  },
  {
    script: 'vitest run; cd android && ./gradlew testDebugUnitTest',
    expected: { android: 'gradlew', 'android-device': 'gradlew' },
  },
  { script: 'jest && cargo test', expected: { rust: 'cargo' } },
  { script: 'jest --testPathIgnorePatterns=e2e-cargo-test', expected: {}, why: 'only whole runner words count' },
  {
    script: 'playwright test && maestro test .maestro',
    expected: { web: 'playwright', 'e2e-ios': 'maestro', 'e2e-android': 'maestro' },
  },
])('the test script $script also runs $expected', ({ script, expected }) => {
  expect(Object.fromEntries(scriptRunsKinds(script))).toEqual(expected);
});
