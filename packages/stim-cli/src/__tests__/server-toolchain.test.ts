import { describe, expect, it } from 'vitest';
import type { ToolchainProbe } from '@stim-cli/core/toolchain';
import { serviceToolchainEntries, serviceToolchainFindings, servicePaths } from '../diagnostics/server-toolchain.ts';
import { service, setup } from './_server-setup.ts';

const pinned = service({
  installed: {
    ...service().installed,
    host: '/Users/me/Applications/Stim Host.app/Contents/MacOS/stim-host',
    node: '/opt/homebrew/Cellar/node/24.1.0/bin/node',
    script: '/Users/me/Library/Application Support/Stim/services/dev.stim.server/versions/1.41.0/stim-server.mjs',
    pathPrepend: ['/opt/homebrew/opt/cocoapods/bin'],
    env: ['JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home', 'FOO=/not/a/path'],
  },
});

describe('service toolchain', () => {
  it('lists the paths a start depends on and the path variables a service pins', () => {
    expect(new Set(servicePaths(pinned.installed))).toEqual(
      new Set([
        '/Users/me/Applications/Stim Host.app/Contents/MacOS/stim-host',
        '/opt/homebrew/Cellar/node/24.1.0/bin/node',
        '/Users/me/Library/Application Support/Stim/services/dev.stim.server/versions/1.41.0/stim-server.mjs',
        '/opt/homebrew/opt/cocoapods/bin',
        '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home',
      ]),
    );
  });

  it('says a service cannot start when its node, after a Homebrew upgrade, is gone', () => {
    const [finding] = serviceToolchainFindings(
      setup({ services: [pinned], missingPaths: ['/opt/homebrew/Cellar/node/24.1.0/bin/node'] }),
    );
    expect(finding).toMatchObject({ code: 'server-service-paths', level: 'cost' });
    expect(finding?.detail).toContain('the service cannot start');
    expect(finding?.fix).toContain('stim service install --port 7788');
  });

  it('notes a missing tool directory, which the service starts without', () => {
    const [finding] = serviceToolchainFindings(
      setup({ services: [pinned], missingPaths: ['/opt/homebrew/opt/cocoapods/bin'] }),
    );
    expect(finding?.level).toBe('note');
  });

  it('is quiet when every recorded path exists', () => {
    expect(serviceToolchainFindings(setup({ services: [pinned], missingPaths: [] }))).toEqual([]);
  });

  it("finds tools the way the server's own discovery does: the service's node, pinned --env and --path-prepend", () => {
    const files = new Set([
      '/opt/homebrew/Cellar/node/24.1.0/bin/node',
      '/Volumes/SSD/sdk/platform-tools/adb',
      '/opt/homebrew/opt/cocoapods/bin/brew',
    ]);
    const dirs = new Set([
      '/opt/homebrew/Cellar/node/24.1.0/bin',
      '/Volumes/SSD/sdk/platform-tools',
      '/opt/homebrew/opt/cocoapods/bin',
    ]);
    const probe: ToolchainProbe = {
      home: '/Users/me',
      execPath: '/doctor/node',
      isDir: (path) => dirs.has(path),
      isFile: (path) => files.has(path),
      read: () => null,
      list: () => [],
      link: () => null,
    };
    const custom = {
      ...pinned.installed,
      env: ['ANDROID_HOME=/Volumes/SSD/sdk', 'JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home'],
    };
    const byName = Object.fromEntries(
      serviceToolchainEntries(custom, '/Users/me', probe).map((entry) => [entry.name, entry]),
    );
    expect(byName.node?.value).toBe('/opt/homebrew/Cellar/node/24.1.0/bin/node');
    expect(byName.ANDROID_HOME).toMatchObject({ value: '/Volumes/SSD/sdk', source: 'environment' });
    expect(byName.adb?.value).toBe('/Volumes/SSD/sdk/platform-tools/adb');
    expect(byName.brew?.value).toBe('/opt/homebrew/opt/cocoapods/bin/brew');
    expect(byName.JAVA_HOME?.source).toBe('environment');
  });
});
