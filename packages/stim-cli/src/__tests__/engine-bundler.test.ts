import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundlerPin } from '../engine/bundler.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-bundler-'));
  writeFileSync(join(root, 'Gemfile'), "source 'https://rubygems.org'\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function lock(text: string) {
  writeFileSync(join(root, 'Gemfile.lock'), text);
}

const GEM_SPECS = ['GEM', '  remote: https://rubygems.org/', '  specs:'];

test('cocoapods as another gem dependency, with no spec of its own, is NOT a pin', () => {
  lock([...GEM_SPECS, '    cocoapods-catalyst-support (0.2.1)', '      cocoapods (>= 1.10)', ''].join('\n'));
  expect(bundlerPin(root)).toBe(null);
});

test('a CHECKSUMS entry alone is NOT a pin: those lines are indented two spaces', () => {
  lock(
    [
      ...GEM_SPECS,
      '    fastlane (2.219.0)',
      '',
      'CHECKSUMS',
      '  cocoapods (1.15.2) sha256=0d1e2f',
      '',
      'DEPENDENCIES',
      '  fastlane',
      '',
    ].join('\n'),
  );
  expect(bundlerPin(root)).toBe(null);
});
