import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanEntryValid } from '../workspace/scan-rules.ts';

describe('scanEntryValid with a hand-edited scan result', () => {
  let home: string;
  const isCheckout = (path: string) => existsSync(join(path, 'package.json'));
  const rules = () => ({ home, isCheckout, skip: (path: string) => path.startsWith(join(home, '.stim')) });
  const project = (...parts: string[]) => {
    mkdirSync(join(home, ...parts), { recursive: true });
    writeFileSync(join(home, ...parts, 'package.json'), '{}');
    return join(home, ...parts);
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-scan-rules-')));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('accepts a real checkout the scan could have found', () => {
    expect(scanEntryValid(project('dev', 'app'), rules())).toBe(true);
  });

  it('refuses entries the scan never finds: the filesystem root, another home, the Stim home, pruned and skipped folders', () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'stim-scan-other-')));
    try {
      writeFileSync(join(other, 'package.json'), '{}');
      for (const path of [
        '/',
        home,
        other,
        project('.stim', 'x'),
        project('.npm', 'x'),
        project('dev', 'node_modules', 'x'),
        project('Desktop', 'x'),
      ])
        expect(scanEntryValid(path, rules())).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a path through a symlinked ancestor, a symlinked checkout and a different-case spelling of a pruned folder', () => {
    const real = project('elsewhere', 'app');
    mkdirSync(join(home, 'dev'));
    symlinkSync(join(home, 'elsewhere'), join(home, 'dev', 'link'));
    symlinkSync(real, join(home, 'dev', 'app-link'));
    expect(scanEntryValid(join(home, 'dev', 'link', 'app'), rules())).toBe(false);
    expect(scanEntryValid(join(home, 'dev', 'app-link'), rules())).toBe(false);
    const cached = project('.claude', 'x');
    expect(scanEntryValid(cached, rules())).toBe(false);
    const upper = join(home, '.CLAUDE', 'x');
    expect(scanEntryValid(upper, rules())).toBe(false);
  });
});
