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

  it('accepts a real checkout the scan could have found', async () => {
    expect(await scanEntryValid(project('dev', 'app'), rules())).toBe('valid');
  });

  it('refuses entries the scan never finds: the filesystem root, another home, the Stim home, pruned and skipped folders', async () => {
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
        expect(await scanEntryValid(path, rules())).toBe('invalid');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a path through a symlinked ancestor, a symlinked checkout and a different-case spelling of a pruned folder', async () => {
    const real = project('elsewhere', 'app');
    mkdirSync(join(home, 'dev'));
    symlinkSync(join(home, 'elsewhere'), join(home, 'dev', 'link'));
    symlinkSync(real, join(home, 'dev', 'app-link'));
    expect(await scanEntryValid(join(home, 'dev', 'link', 'app'), rules())).toBe('invalid');
    expect(await scanEntryValid(join(home, 'dev', 'app-link'), rules())).toBe('invalid');
    const cached = project('.claude', 'x');
    expect(await scanEntryValid(cached, rules())).toBe('invalid');
    const upper = join(home, '.CLAUDE', 'x');
    expect(await scanEntryValid(upper, rules())).toBe('invalid');
  });

  describe('before project detection runs', () => {
    const file = (name: string) => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    });
    const fifo = (name: string) => ({
      name,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    });
    const folder = (name: string) => ({
      name,
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    });

    it('does not call detection for a detection file that is not regular, or for an Xcode container', async () => {
      const detect = vi.fn<(path: string) => boolean>(() => true);
      for (const entries of [
        [fifo('package.json')],
        [file('package.json'), fifo('gradlew')],
        [folder('App.xcodeproj')],
      ]) {
        const io = { readEntries: async () => entries, readText: async () => '{"dependencies":{"expo":"*"}}' };
        const path = project('dev', 'app');
        const result = await scanEntryValid(path, { ...rules(), isCheckout: detect, io });
        expect(result).toBe('invalid');
      }
      expect(detect).not.toHaveBeenCalled();
    });

    it('does not call detection while a manifest read is pending, leaves the entry pending, and recovers once it settles', async () => {
      const detect = vi.fn<(path: string) => boolean>(() => true);
      let release: (text: string) => void = () => {};
      const stuck = {
        readEntries: async () => [file('package.json')],
        readText: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      };
      const path = project('dev', 'app');
      const first = scanEntryValid(path, { ...rules(), isCheckout: detect, io: stuck, timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toBe('pending');
      expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io: stuck, timeoutMs: 10 })).toBe('pending');
      expect(detect).not.toHaveBeenCalled();

      release('{}');
      await vi.advanceTimersByTimeAsync(0);
      const ok = { readEntries: async () => [file('package.json')], readText: async () => '{}' };
      expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io: ok })).toBe('valid');
    });
  });
});
