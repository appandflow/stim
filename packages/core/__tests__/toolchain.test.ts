import { describe, expect, it } from 'vitest';
import { delimiter, join } from 'node:path';
import { discoverToolchain, projectNodeBin, type ToolchainProbe } from '../toolchain.ts';

const HOME = '/Users/me';
const fixturePath = (path: string) => path.replaceAll('\\', '/');

function probe(files: Record<string, string>, execPath = '/Applications/Stim.app/Contents/Resources/node/bin/node') {
  const paths = [...Object.keys(files), execPath];
  const isDir = (path: string) => paths.some((file) => file.startsWith(`${fixturePath(path)}/`));
  return {
    home: HOME,
    execPath,
    isDir,
    isFile: (path) => fixturePath(path) in files,
    read: (path) => files[fixturePath(path)] ?? null,
    list: (path) =>
      isDir(path)
        ? [
            ...new Set(
              paths
                .filter((file) => file.startsWith(`${fixturePath(path)}/`))
                .map((file) => file.slice(fixturePath(path).length + 1).split('/')[0] ?? ''),
            ),
          ]
        : [],
  } satisfies ToolchainProbe;
}

const nvm = (version: string) => ({ [`${HOME}/.nvm/versions/node/${version}/bin/node`]: '' });

describe('discoverToolchain', () => {
  it('appends the nvm default Node, Homebrew and the Android SDK after the caller PATH and keeps what it sets', () => {
    const { env } = discoverToolchain(
      { PATH: ['/usr/bin', '/bin'].join(delimiter), JAVA_HOME: '/custom/jdk', KEEP: 'yes' },
      probe({
        [`${HOME}/.nvm/alias/default`]: 'lts/*\n',
        [`${HOME}/.nvm/alias/lts/*`]: 'lts/iron',
        [`${HOME}/.nvm/alias/lts/iron`]: '20',
        ...nvm('v20.11.0'),
        ...nvm('v20.18.3'),
        ...nvm('v22.12.0'),
        '/opt/homebrew/bin/node': '',
        [`${HOME}/Library/Android/sdk/platform-tools/adb`]: '',
        '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java': '',
      }),
    );
    expect(env.PATH?.split(delimiter)).toEqual([
      '/usr/bin',
      '/bin',
      join(HOME, '.nvm', 'versions', 'node', 'v20.18.3', 'bin'),
      '/opt/homebrew/bin',
      join(HOME, 'Library', 'Android', 'sdk', 'platform-tools'),
      '/Applications/Stim.app/Contents/Resources/node/bin',
    ]);
    expect(env.ANDROID_HOME).toBe(join(HOME, 'Library', 'Android', 'sdk'));
    expect(env.JAVA_HOME).toBe('/custom/jdk');
    expect(env.KEEP).toBe('yes');
  });

  it('extends the Windows Path instead of replacing it with a second PATH', () => {
    const path = ['C:\\Program Files\\Git\\cmd', 'C:\\Windows\\system32'].join(delimiter);
    const { env } = discoverToolchain({ Path: path }, probe({}), { platform: 'win32' });
    expect(Object.keys(env).filter((key) => /^path$/i.test(key))).toEqual(['PATH']);
    expect(env.PATH?.startsWith(`${path}${delimiter}`)).toBe(true);
  });

  it('leaves the Node the caller already has on PATH', () => {
    const { env, entries } = discoverToolchain(
      { PATH: '/opt/local/bin' },
      probe({ '/opt/local/bin/node': '', [`${HOME}/.nvm/alias/default`]: '22', ...nvm('v22.12.0') }),
    );
    expect(env.PATH).not.toContain('.nvm');
    expect(entries.find((entry) => entry.name === 'node')).toMatchObject({
      value: join('/opt/local/bin', 'node'),
      source: 'environment',
    });
  });

  it('falls back to the running Node when no version manager has a default', () => {
    const { entries } = discoverToolchain(
      { PATH: '/usr/bin' },
      probe({ '/stim/node/bin/node': '' }, '/stim/node/bin/node'),
    );
    expect(entries.find((entry) => entry.name === 'node')).toMatchObject({
      value: join('/stim/node/bin', 'node'),
      from: 'the Node running Stim',
    });
  });

  it("uses a system JDK through /usr/bin/java, else Homebrew's JDK 17, else Android Studio's runtime", () => {
    const studio = { '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java': '' };
    const withJdk = discoverToolchain(
      { PATH: '/usr/bin' },
      probe({ ...studio, '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home/bin/java': '' }),
    );
    expect(withJdk.env.JAVA_HOME).toBeUndefined();
    const studioOnly = discoverToolchain({ PATH: '/usr/bin' }, probe(studio));
    expect(studioOnly.env.JAVA_HOME).toBe(
      join('/Applications/Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home'),
    );
    const brew = (name: string) => ({ [`/opt/homebrew/opt/${name}/libexec/openjdk.jdk/Contents/Home/bin/java`]: '' });
    const homebrewOnly = discoverToolchain(
      { PATH: '/usr/bin' },
      probe({ ...studio, ...brew('openjdk'), ...brew('openjdk@21'), ...brew('openjdk@17') }),
    );
    expect(homebrewOnly.env.JAVA_HOME).toBe(
      join('/opt/homebrew', 'opt', 'openjdk@17', 'libexec', 'openjdk.jdk', 'Contents', 'Home'),
    );
  });
});

describe('projectNodeBin', () => {
  it('picks the newest installed version that the pin names', () => {
    const files = { '/app/.nvmrc': 'v20\n', ...nvm('v20.11.0'), ...nvm('v20.18.3'), ...nvm('v22.12.0') };
    expect(projectNodeBin('/app', {}, probe(files))).toEqual({
      bin: join(HOME, '.nvm', 'versions', 'node', 'v20.18.3', 'bin'),
      version: '20.18.3',
      pin: '.nvmrc',
      spec: 'v20',
    });
  });

  it("reads Volta's pin from package.json and finds it in Volta's image", () => {
    const files = {
      '/app/package.json': JSON.stringify({ volta: { node: '22.12.0' } }),
      [`${HOME}/.volta/tools/image/node/22.12.0/bin/node`]: '',
    };
    expect(projectNodeBin('/app', {}, probe(files))?.bin).toBe(
      join(HOME, '.volta', 'tools', 'image', 'node', '22.12.0', 'bin'),
    );
  });

  it('finds a Homebrew keg by its Cellar version, revision suffix included', () => {
    const files = {
      '/app/.nvmrc': '22\n',
      '/opt/homebrew/Cellar/node/26.7.0/bin/node': '',
      '/opt/homebrew/Cellar/node@22/22.23.2_1/bin/node': '',
    };
    expect(projectNodeBin('/app', {}, probe(files))).toEqual({
      bin: join('/opt/homebrew', 'Cellar', 'node@22', '22.23.2_1', 'bin'),
      version: '22.23.2',
      pin: '.nvmrc',
      spec: '22',
    });
  });

  it('prefers an exact match, then falls back to the newest install of the pinned major', () => {
    const exact = {
      '/app/.nvmrc': '22.22.0\n',
      ...nvm('v22.22.0'),
      '/opt/homebrew/Cellar/node@22/22.23.2_1/bin/node': '',
    };
    expect(projectNodeBin('/app', {}, probe(exact))?.version).toBe('22.22.0');
    const fallback = {
      '/app/.nvmrc': '22.22.0\n',
      ...nvm('v22.20.0'),
      ...nvm('v24.11.0'),
      '/opt/homebrew/Cellar/node@24/24.18.0/bin/node': '',
    };
    expect(projectNodeBin('/app', {}, probe(fallback))?.version).toBe('22.20.0');
  });

  it('reads the pin of the nearest directory above the app, but not above the top directory', () => {
    const files = { '/repo/.nvmrc': '22\n', '/.nvmrc': '20\n', ...nvm('v22.12.0'), ...nvm('v20.11.0') };
    expect(projectNodeBin('/repo/apps/mobile', {}, probe(files), '/repo')?.version).toBe('22.12.0');
    expect(projectNodeBin('/repo/apps/mobile', {}, probe(files), '/repo/apps/mobile')).toBeNull();
  });

  it('returns nothing when no installed version satisfies the pin', () => {
    expect(projectNodeBin('/app', {}, probe({ '/app/.node-version': '18.20.0', ...nvm('v20.11.0') }))).toBeNull();
  });
});
