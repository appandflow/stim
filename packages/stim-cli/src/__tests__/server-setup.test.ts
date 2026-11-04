import { describe, expect, it } from 'vitest';
import {
  classifyServers,
  parseProcessRows,
  parseServerProcesses,
  serverSetupFindings,
  type InstalledServerService,
  type ServerReading,
  type ServerSetup,
} from '../diagnostics/server-setup.ts';

const PS = `
    1     0 /sbin/launchd
29063     1 /Applications/Stim.app/Contents/MacOS/StimDesktop
29421 29063 /Applications/Stim.app/Contents/Resources/stim-server/bin/node /Applications/Stim.app/Contents/Resources/stim-server/node_modules/@stim-cli/server/dist/stim-server.mjs --port 7787
40100     1 /Users/me/Library/Application Support/Stim/Stim Host.app/Contents/MacOS/stim-host run /Users/me/.nvm/versions/node/v22.22.2/bin/node /Users/me/Library/Application Support/Stim/services/dev.stim.server/versions/1.40.0/node_modules/@stim-cli/server/dist/stim-server.mjs --port 7788 --path-prepend /opt/homebrew/bin
40110 40100 /Users/me/.nvm/versions/node/v22.22.2/bin/node /Users/me/Library/Application Support/Stim/services/dev.stim.server/versions/1.40.0/node_modules/@stim-cli/server/dist/stim-server.mjs --port 7788 --path-prepend /opt/homebrew/bin
50200  4000 node --no-warnings /Users/me/.nvm/versions/node/v22.22.2/bin/stim-server --port 7790
50300  4000 /Users/me/.nvm/versions/node/v22.22.2/bin/node /Users/me/.nvm/versions/node/v22.22.2/bin/stim-server --share --port 54011
50400  4000 /Users/me/.nvm/versions/node/v22.22.2/bin/node /Users/me/.nvm/versions/node/v22.22.2/bin/stim-server service update --release 1.41.0
50500  4000 tail -f /Users/me/.stim/server/share-server.log
50600  4000 vim /Users/me/Developer/stim/packages/server/bin/stim-server.ts
`;

describe('parseServerProcesses', () => {
  it('does not count an npx wrapper or a shell wrapper, and reads --port=<n>', () => {
    const ps = [
      '700 1 /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js exec stim-server --port 7791',
      '701 700 node /Users/me/.npm/_npx/abc/node_modules/.bin/stim-server --port 7791',
      '710 1 sh -c node /Users/me/bin/stim-server --port 7792',
      '720 1 node /Users/me/bin/stim-server --port=7793',
    ].join('\n');
    expect(parseServerProcesses(ps).map(({ pid, port }) => ({ pid, port }))).toEqual([
      { pid: 701, port: 7791 },
      { pid: 720, port: 7793 },
    ]);
  });

  it('reads only node processes that run the server without a subcommand', () => {
    expect(parseServerProcesses(PS).map(({ pid, port, share }) => ({ pid, port, share }))).toEqual([
      { pid: 29421, port: 7787, share: false },
      { pid: 40110, port: 7788, share: false },
      { pid: 50200, port: 7790, share: false },
      { pid: 50300, port: 54011, share: true },
    ]);
  });
});

const service = (over: Partial<InstalledServerService> = {}): InstalledServerService => ({
  manager: 'launchd',
  label: 'dev.stim.server',
  installed: {
    label: 'dev.stim.server',
    host: null,
    node: '/usr/local/bin/node',
    script: '/Users/me/stim-server.mjs',
    port: 7788,
    env: [],
    pathPrepend: [],
    stimHome: '/Users/me/.stim',
    logPath: '/Users/me/Library/Logs/Stim/dev.stim.server.log',
    managed: true,
    serve: null,
    previousScript: null,
    programArguments: [],
  },
  job: { state: 'running', pid: 40100, runs: 1, lastExitCode: null },
  ...over,
});

const health = (over: Record<string, unknown> = {}) => ({
  version: '1.41.0',
  stim: '1.41.0',
  stimHome: '/Users/me/.stim',
  ...over,
});

describe('classifyServers', () => {
  it('names the starter: the service job, the bundled Desktop server, `stim share`, or a person', () => {
    const rows = parseProcessRows(PS);
    const kinds = classifyServers(parseServerProcesses(PS), rows, [service()]).map(({ pid, kind, label }) => ({
      pid,
      kind,
      label,
    }));
    expect(kinds).toEqual([
      { pid: 29421, kind: 'desktop', label: undefined },
      { pid: 40110, kind: 'service', label: 'dev.stim.server' },
      { pid: 50200, kind: 'manual', label: undefined },
      { pid: 50300, kind: 'share', label: undefined },
    ]);
  });
});

const reading = (over: Partial<ServerReading>): ServerReading => ({
  pid: 100,
  ppid: 1,
  command: '',
  script: '',
  port: 7788,
  share: false,
  kind: 'service',
  label: 'dev.stim.server',
  health: health(),
  ...over,
});

const setup = (over: Partial<ServerSetup> = {}): ServerSetup => ({
  platform: 'darwin',
  stimHome: '/Users/me/.stim',
  version: '1.41.0',
  build: null,
  services: [service()],
  servers: [reading({})],
  local: null,
  clients: { build: 0, deviceHost: 0 },
  ...over,
});

const codes = (value: ServerSetup) => serverSetupFindings(value).map((finding) => finding.code);

describe('serverSetupFindings', () => {
  it('reports nothing for one current server on this Stim home', () => {
    expect(serverSetupFindings(setup())).toEqual([]);
  });

  it('keeps the service when Desktop and a manual server also serve the home, and says how to stop the rest', () => {
    const [finding] = serverSetupFindings(
      setup({
        servers: [
          reading({}),
          reading({ pid: 200, port: 7787, kind: 'desktop', label: undefined }),
          reading({ pid: 300, port: 7790, kind: 'manual', label: undefined }),
        ],
      }),
    );
    expect(finding).toMatchObject({ code: 'server-multiple', level: 'cost' });
    expect(finding?.fix).toContain('Keep pid 100, the dev.stim.server service');
    expect(finding?.fix).toContain('-stimServerPort 7788');
    expect(finding?.fix).toContain('`kill 300`');
  });

  it('keeps the server that holds the local socket when no service is installed', () => {
    const [finding] = serverSetupFindings(
      setup({
        services: [],
        servers: [
          reading({ pid: 200, port: 7787, kind: 'desktop', label: undefined }),
          reading({ pid: 300, port: 7790, kind: 'manual', label: undefined }),
        ],
        local: { port: 7790, version: '1.41.0', features: [] },
      }),
    );
    expect(finding?.fix).toContain('Keep pid 300');
  });

  it('does not count servers of different Stim homes or a `stim share` server as one home served twice', () => {
    expect(
      codes(
        setup({
          servers: [
            reading({}),
            reading({
              pid: 300,
              port: 7790,
              kind: 'manual',
              label: undefined,
              health: health({ stimHome: '/tmp/scratch' }),
            }),
            reading({ pid: 400, port: 54011, kind: 'share', label: undefined }),
          ],
        }),
      ),
    ).toEqual(['server-home', 'server-leftover']);
  });

  it('suggests a service update for an older service server and an app update for the bundled one', () => {
    const findings = serverSetupFindings(
      setup({
        servers: [
          reading({ health: health({ stim: '1.40.0' }) }),
          reading({
            pid: 200,
            port: 7787,
            kind: 'desktop',
            label: undefined,
            health: health({ stim: '1.40.0', stimHome: '/Users/me/other' }),
          }),
        ],
      }),
    );
    const versions = findings.filter((each) => each.code === 'server-version');
    expect(versions[0]?.fix).toBe('Run `stim-server service update --release 1.41.0`.');
    expect(versions[1]?.fix).toContain('Update Stim Desktop');
  });

  it('asks to update the CLI when the server is newer', () => {
    const [finding] = serverSetupFindings(setup({ servers: [reading({ health: health({ stim: '1.42.0' }) })] }));
    expect(finding?.fix).toContain('npm install --global stim@1.42.0');
  });

  it('shows both homes and the reinstall command for a service on another home', () => {
    const [finding] = serverSetupFindings(
      setup({ servers: [reading({ health: health({ stimHome: '/Users/me/.stim-work' }) })] }),
    );
    expect(finding?.code).toBe('server-home');
    expect(finding?.detail).toContain('/Users/me/.stim-work');
    expect(finding?.fix).toContain('STIM_HOME=/Users/me/.stim stim-server service install --port 7788');
  });

  describe('service state', () => {
    const down = (job: InstalledServerService['job'], previousScript: string | null = null) =>
      serverSetupFindings(
        setup({
          services: [service({ job, installed: { ...service().installed, previousScript } })],
          servers: [],
        }),
      );

    it('reports a loaded job that keeps exiting, with the log and rollback when a previous server exists', () => {
      const [finding] = down(
        { state: 'spawn scheduled', pid: null, runs: 14, lastExitCode: '1' },
        '/old/stim-server.mjs',
      );
      expect(finding).toMatchObject({ code: 'server-service-crash', level: 'cost' });
      expect(finding?.detail).toContain('14 times');
      expect(finding?.fix).toContain('dev.stim.server.log');
      expect(finding?.fix).toContain('stim-server service rollback');
    });

    it('does not call a service that has never exited a crash while its health is slow to answer', () => {
      expect(
        serverSetupFindings(
          setup({
            services: [service({ job: { state: 'running', pid: 100, runs: 1, lastExitCode: '(never exited)' } })],
            servers: [reading({ health: null })],
          }),
        ),
      ).toEqual([]);
    });

    it('reports an installed service with no job', () => {
      const [finding] = down(null);
      expect(finding?.title).toContain('installed but not running');
      expect(finding?.fix).toContain('launchctl bootstrap');
    });

    it('notes a running service that restarted but is healthy now, and ignores one with a clean exit', () => {
      const flapping = serverSetupFindings(
        setup({ services: [service({ job: { state: 'running', pid: 100, runs: 5, lastExitCode: '1' } })] }),
      );
      expect(flapping[0]).toMatchObject({ code: 'server-service-crash', level: 'note' });
      expect(
        serverSetupFindings(
          setup({ services: [service({ job: { state: 'running', pid: 100, runs: 5, lastExitCode: '0' } })] }),
        ),
      ).toEqual([]);
    });
  });

  it('lists servers started by hand with their home and port, without stopping them', () => {
    const leftover = serverSetupFindings(
      setup({
        servers: [
          reading({}),
          reading({
            pid: 300,
            port: 7790,
            kind: 'manual',
            label: undefined,
            health: health({ stimHome: '/tmp/scratch' }),
          }),
        ],
      }),
    ).find((each) => each.code === 'server-leftover');
    expect(leftover?.detail).toContain('pid 300');
    expect(leftover?.detail).toContain('Stim home /tmp/scratch');
    expect(leftover?.detail).toContain('port 7790');
  });

  it('lists a server of another Stim home as a leftover even while another home has two servers', () => {
    const findings = serverSetupFindings(
      setup({
        servers: [
          reading({}),
          reading({ pid: 200, port: 7787, kind: 'desktop', label: undefined }),
          reading({
            pid: 300,
            port: 7790,
            kind: 'manual',
            label: undefined,
            health: health({ stimHome: '/tmp/scratch' }),
          }),
        ],
      }),
    );
    expect(findings.map((each) => each.code)).toContain('server-multiple');
    expect(findings.find((each) => each.code === 'server-leftover')?.detail).toContain('pid 300');
  });

  it('notes two builds that report one version', () => {
    const [finding] = serverSetupFindings(
      setup({ build: 'aaaa1111', servers: [reading({ health: health({ stimBuild: 'bbbb2222' }) })] }),
    );
    expect(finding).toMatchObject({ code: 'server-version', level: 'note' });
    expect(finding?.detail).toContain('bbbb2222 and aaaa1111');
    expect(
      serverSetupFindings(
        setup({ build: 'aaaa1111', servers: [reading({ health: health({ stimBuild: 'aaaa1111' }) })] }),
      ),
    ).toEqual([]);
  });

  describe('keep awake', () => {
    const asleep = { setting: false, held: false, reason: 'off' };
    it('flags a Mac that serves approved build clients with keep-awake off', () => {
      const value = setup({
        clients: { build: 2, deviceHost: 1 },
        servers: [reading({ health: health({ keepAwake: asleep }) })],
      });
      expect(codes(value)).toEqual(['server-keep-awake']);
    });

    it.each([
      [
        'no approved clients',
        { clients: { build: 0, deviceHost: 0 }, servers: [reading({ health: health({ keepAwake: asleep }) })] },
      ],
      [
        'an assertion held',
        {
          clients: { build: 1, deviceHost: 0 },
          servers: [reading({ health: health({ keepAwake: { setting: true, held: true } }) })],
        },
      ],
      ['a server that predates the field', { clients: { build: 1, deviceHost: 0 } }],
      [
        'Linux, where keep-awake does not apply',
        {
          platform: 'linux' as const,
          clients: { build: 1, deviceHost: 0 },
          servers: [reading({ health: health({ keepAwake: asleep }) })],
        },
      ],
    ])('is quiet with %s', (_name, over) => {
      expect(codes(setup(over))).toEqual([]);
    });
  });

  describe('Desktop write authority', () => {
    it('flags a service server on the local socket that does not advertise it, with the update command', () => {
      const [finding] = serverSetupFindings(
        setup({
          version: '1.42.0',
          servers: [reading({ health: health({ stim: '1.42.0' }) })],
          local: { port: 7788, version: '1.40.0', features: ['desktop-reports'] },
        }),
      );
      expect(finding).toMatchObject({ code: 'server-desktop-authority', level: 'cost' });
      expect(finding?.fix).toBe('Run `stim-server service update --release 1.42.0`.');
    });

    it('does not flag Desktop-keyed servers or servers that advertise it', () => {
      const local = { port: 7788, version: '1.41.0', features: [] };
      expect(codes(setup({ servers: [reading({ kind: 'desktop', label: undefined })], local }))).toEqual([]);
      expect(codes(setup({ local: { ...local, features: ['desktop-local-authority'] } }))).toEqual([]);
    });
  });
});
