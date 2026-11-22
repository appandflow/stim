import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REAL_RECOGNITION_IO,
  type RecognitionIo,
  folderSafety,
  nestedSafety,
  scanDescends,
  scanEntryValid,
} from '../workspace/scan-rules.ts';

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

  it('keeps an entry whose metadata read fails for anything but proven absence as pending, and drops one that is absent', async () => {
    const path = project('dev', 'app');
    const failing = (code: string) => ({
      ...REAL_RECOGNITION_IO,
      lstat: async (target: string) => {
        if (target === path) throw Object.assign(new Error(code), { code });
        return REAL_RECOGNITION_IO.lstat(target);
      },
    });
    for (const code of ['EACCES', 'EPERM', 'EIO'])
      expect(await scanEntryValid(path, { ...rules(), io: failing(code) })).toBe('pending');
    for (const code of ['ENOENT', 'ENOTDIR'])
      expect(await scanEntryValid(path, { ...rules(), io: failing(code) })).toBe('invalid');
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

  it('skips the protected home folders in any letter case, so a saved find under one is invalid before any read', async () => {
    for (const name of ['Documents', 'documents', 'DOCUMENTS']) expect(scanDescends(name, 1)).toBe(false);
    const refuse = async (): Promise<never> => {
      throw new Error('read');
    };
    const silent = {
      readEntries: refuse,
      readText: refuse,
      lstat: refuse,
      stat: refuse,
      realpath: refuse,
      metadata: refuse,
    };
    for (const name of ['documents', 'DOCUMENTS'])
      expect(await scanEntryValid(join(home, name, 'app'), { ...rules(), io: silent })).toBe('invalid');
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

    const listing = (listings: Record<string, ReturnType<typeof file>[]>) => ({
      ...REAL_RECOGNITION_IO,
      readEntries: async (path: string) => listings[path] ?? [],
      readText: async () => '{}',
    });

    it('does not call detection for a detection file that is not regular, or for an Xcode container without an app dependency', async () => {
      const detect = vi.fn<(path: string) => boolean>(() => true);
      const path = project('dev', 'app');
      for (const entries of [
        [fifo('package.json')],
        [file('package.json'), fifo('gradlew')],
        [folder('App.xcodeproj')],
        [file('package.json'), folder('App.xcodeproj')],
      ])
        expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io: listing({ [path]: entries }) })).toBe(
          'invalid',
        );
      expect(detect).not.toHaveBeenCalled();
      const app = {
        ...listing({ [path]: [file('package.json'), folder('App.xcodeproj')] }),
        readText: async () => '{"dependencies":{"expo":"*"}}',
      };
      expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io: app })).toBe('valid');
    });

    it('does not call detection when an ancestor, the home folder or an apps folder holds a manifest that is not a regular file', async () => {
      const detect = vi.fn<(path: string) => boolean>(() => true);
      const path = project('mono', 'apps', 'x');
      const android = [file('settings.gradle'), file('gradlew')];
      const control = listing({
        [join(home, 'mono')]: [folder('apps')],
        [join(home, 'mono', 'apps')]: [folder('x')],
        [path]: android,
      });
      expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io: control })).toBe('valid');
      detect.mockClear();
      for (const unsafe of [home, join(home, 'mono'), join(home, 'mono', 'apps')]) {
        const io = {
          ...control,
          readEntries: async (at: string) => (at === unsafe ? [fifo('package.json')] : await control.readEntries(at)),
        };
        expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io })).toBe('invalid');
      }
      expect(detect).not.toHaveBeenCalled();
    });

    describe('names compare case-insensitively, as a case-insensitive volume reads them', () => {
      const symlink = (name: string) => ({
        name,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      });
      const where = '/work/x';

      it('finds a FIFO manifest, a symlinked container and a symlinked or non-directory ios or android root whatever the case', async () => {
        expect(await folderSafety(where, [fifo('PACKAGE.JSON')], 10)).toBe('unsafe');
        expect(await folderSafety(where, [fifo('App.JSON')], 10)).toBe('unsafe');
        expect(await folderSafety(where, [symlink('iOS')], 10)).toBe('unsafe');
        expect(await folderSafety(where, [file('Android')], 10)).toBe('unsafe');
        expect(await folderSafety(where, [folder('IOS'), folder('android')], 10)).toBe('safe');
        expect(await nestedSafety(where, [symlink('APPS')], 10)).toBe('unsafe');
        expect(await nestedSafety(where, [symlink('Packages')], 10)).toBe('unsafe');
      });

      it('keeps the Xcode exemption only when every manifest that folds to package.json declares an app dependency', async () => {
        const declaring = JSON.stringify({ dependencies: { expo: '*' } });
        const texts: Record<string, string> = {};
        const io = { ...REAL_RECOGNITION_IO, readText: async (path: string) => texts[path] ?? '{}' };
        const entries = [file('package.json'), file('Package.JSON'), folder('X.xcodeproj')];
        texts['/work/x/Package.JSON'] = declaring;
        expect(await folderSafety(where, entries, 10, io)).toBe('unsafe');
        texts['/work/x/package.json'] = declaring;
        expect(await folderSafety(where, entries, 10, io)).toBe('safe');
      });

      it('is denied, never safe, when a child that detection enumerates cannot be listed', async () => {
        const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
        const gone = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        const io = (failure: Error) => ({
          ...REAL_RECOGNITION_IO,
          readEntries: async (path: string) => {
            if (path === '/work/x/apps') return [folder('app')];
            if (path === '/work/x/apps/app') throw failure;
            return [];
          },
        });
        const entries = [folder('apps')];
        expect(await nestedSafety(where, entries, 10, io(denied))).toBe('denied');
        expect(await nestedSafety(where, entries, 10, io(gone))).toBe('safe');
      });

      it('reads a mixed-case regular manifest through the bounded reader instead of skipping it', async () => {
        const reads: string[] = [];
        const io = {
          ...REAL_RECOGNITION_IO,
          readText: async (path: string) => {
            reads.push(path);
            return '{}';
          },
        };
        expect(await folderSafety(where, [file('Package.JSON')], 10, io)).toBe('safe');
        expect(reads).toEqual([join(where, 'Package.JSON')]);
        expect(await folderSafety(where, [file('PACKAGE.JSON'), folder('App.XCODEPROJ')], 10, io)).toBe('unsafe');
      });
    });

    it('treats a metadata read that does not answer as pending, before any detection', async () => {
      const detect = vi.fn<(path: string) => boolean>(() => true);
      let release: (value: Awaited<ReturnType<RecognitionIo['lstat']>>) => void = () => {};
      let started = 0;
      const stuck = {
        ...listing({}),
        lstat: () => {
          started++;
          return new Promise<Awaited<ReturnType<RecognitionIo['lstat']>>>((resolve) => {
            release = resolve;
          });
        },
      };
      const path = project('dev', 'app');
      const first = scanEntryValid(path, { ...rules(), isCheckout: detect, io: stuck, timeoutMs: 10 });
      const waiting = { started: () => started > 0 };
      while (!waiting.started()) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toBe('pending');
      expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io: stuck })).toBe('pending');
      expect(started).toBe(1);
      expect(detect).not.toHaveBeenCalled();
      release({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true });
      await vi.advanceTimersByTimeAsync(0);
    });

    it('does not call detection while a manifest read is pending, leaves the entry pending, and recovers once it settles', async () => {
      const detect = vi.fn<(path: string) => boolean>(() => true);
      let release: (text: string) => void = () => {};
      let started = 0;
      const path = project('dev', 'app');
      const stuck = {
        ...listing({ [path]: [file('package.json')] }),
        readText: () => {
          started++;
          return new Promise<string>((resolve) => {
            release = resolve;
          });
        },
      };
      const first = scanEntryValid(path, { ...rules(), isCheckout: detect, io: stuck, timeoutMs: 10 });
      const waiting = { started: () => started > 0 };
      while (!waiting.started()) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toBe('pending');
      expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io: stuck, timeoutMs: 10 })).toBe('pending');
      expect(detect).not.toHaveBeenCalled();

      release('{}');
      await vi.advanceTimersByTimeAsync(0);
      const ok = listing({ [path]: [file('package.json')] });
      expect(await scanEntryValid(path, { ...rules(), isCheckout: detect, io: ok })).toBe('valid');
    });
  });
});
