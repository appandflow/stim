import type {
  InstalledServerService,
  ServerHealthReading,
  NetworkReading,
  ServerReading,
  ServerSetup,
} from '../diagnostics/server-setup.ts';

export const service = (over: Partial<InstalledServerService> = {}): InstalledServerService => ({
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

export const health = (over: Record<string, unknown> = {}): ServerHealthReading => ({
  version: '1.41.0',
  stim: '1.41.0',
  stimHome: '/Users/me/.stim',
  ...over,
});

export const reading = (over: Partial<ServerReading>): ServerReading => ({
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

export const setup = (over: Partial<ServerSetup> = {}): ServerSetup => ({
  platform: 'darwin',
  stimHome: '/Users/me/.stim',
  version: '1.41.0',
  build: null,
  services: [service()],
  servers: [reading({})],
  local: null,
  clients: { build: 0, deviceHost: 0 },
  network: network(),
  missingPaths: [],
  ...over,
});

export const network = (over: Partial<NetworkReading> = {}): NetworkReading => ({
  host: 'Janics-Mac-mini',
  tailscaleStatus: { BackendState: 'Running', Self: { DNSName: 'mini.tail1234.ts.net.', HostName: 'Janics-Mac-mini' } },
  serve: {},
  share: { exposure: 'auto', publicUrl: null },
  shares: null,
  notsentLowat: null,
  ...over,
});
