import { describe, expect, it } from 'vitest';
import { serviceToolchainEnv, serviceToolchainFindings, servicePaths } from '../diagnostics/server-toolchain.ts';
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
    expect(servicePaths(pinned.installed)).toEqual([
      '/Users/me/Applications/Stim Host.app/Contents/MacOS/stim-host',
      '/opt/homebrew/Cellar/node/24.1.0/bin/node',
      '/Users/me/Library/Application Support/Stim/services/dev.stim.server/versions/1.41.0/stim-server.mjs',
      '/opt/homebrew/opt/cocoapods/bin',
      '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home',
    ]);
  });

  it('says a service cannot start when its node, after a Homebrew upgrade, is gone', () => {
    const [finding] = serviceToolchainFindings(
      setup({ services: [pinned], missingPaths: ['/opt/homebrew/Cellar/node/24.1.0/bin/node'] }),
    );
    expect(finding).toMatchObject({ code: 'server-service-paths', level: 'cost' });
    expect(finding?.detail).toContain('the service cannot start');
    expect(finding?.fix).toContain('stim-server service install --port 7788');
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

  it("builds the environment the service's own settings give discovery: prepended directories, then launchd's PATH", () => {
    expect(serviceToolchainEnv(pinned.installed, '/Users/me')).toEqual({
      HOME: '/Users/me',
      PATH: '/opt/homebrew/opt/cocoapods/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      JAVA_HOME: '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home',
      FOO: '/not/a/path',
    });
  });
});
