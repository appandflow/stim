import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  applyServeEnvironment,
  parseEnvAssignment,
  parseInstalledPlist,
  parseLaunchctlPrint,
  planServe,
  renderPlist,
  validateServeEnvironment,
  type ServiceSpec,
} from '../src/service-plist.ts';

const SPEC: ServiceSpec = {
  label: 'dev.stim.server',
  node: '/opt/homebrew/bin/node',
  script: '/Users/me/stim & co/node_modules/@stim-cli/server/dist/stim-server.mjs',
  port: 7787,
  env: ['GEM_HOME=/gems', 'LANG=en_US.UTF-8'],
  pathPrepend: ['/gems/bin'],
  environment: { STIM_HOME: '/tmp/scratch home', SHELL: '/bin/zsh' },
  logPath: '/Users/me/Library/Logs/Stim/dev.stim.server.log',
  workingDirectory: '/Users/me',
  serve: { port: 7443, created: true },
};

const BIN = join(import.meta.dirname, '..', 'bin', 'stim-server.ts');

describe('service plist', () => {
  it('escapes XML in arguments', () => {
    expect(renderPlist(SPEC)).toContain('/Users/me/stim &amp; co/node_modules');
  });

  describe.skipIf(process.platform !== 'darwin')('with plutil', () => {
    it('reads back as the spec it was built from', () => {
      const dir = mkdtempSync(join(tmpdir(), 'stim-service-plist-'));
      try {
        const file = join(dir, 'job.plist');
        writeFileSync(file, renderPlist(SPEC));
        const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
        expect(json).toMatchObject({ Label: SPEC.label, RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30 });
        expect(parseInstalledPlist(json)).toEqual({
          label: SPEC.label,
          node: SPEC.node,
          script: SPEC.script,
          port: 7787,
          env: SPEC.env,
          pathPrepend: SPEC.pathPrepend,
          stimHome: '/tmp/scratch home',
          logPath: SPEC.logPath,
          managed: true,
          serve: { port: 7443, created: true },
        });
        const without = join(dir, 'plain.plist');
        writeFileSync(without, renderPlist({ ...SPEC, serve: null }));
        execFileSync('plutil', ['-lint', without]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('serve environment', () => {
  it('applies --env after the base and prepends directories in order', () => {
    const result = applyServeEnvironment(
      { PATH: '/usr/bin', LANG: 'C', KEEP: '1' },
      ['LANG=en_US.UTF-8'],
      ['/a', '/b'],
    );
    expect(result).toEqual({ PATH: ['/a', '/b', '/usr/bin'].join(delimiter), LANG: 'en_US.UTF-8', KEEP: '1' });
  });

  it('keeps a value containing "="', () => {
    expect(parseEnvAssignment('OPTS=a=b')).toEqual({ key: 'OPTS', value: 'a=b' });
  });

  it('rejects malformed entries and STIM_HOME', () => {
    expect(parseEnvAssignment('NOEQUALS')).toContain('KEY=VALUE');
    expect(validateServeEnvironment(['1BAD=x'], [])).toContain('KEY=VALUE');
    expect(validateServeEnvironment(['STIM_HOME=/x'], [])).toContain('STIM_HOME');
    expect(validateServeEnvironment([], ['relative/dir'])).toContain('absolute');
    expect(validateServeEnvironment(['A=b\u0001'], [])).toContain('control');
    expect(validateServeEnvironment(['A=b'], ['/abs'])).toBeNull();
  });
});

describe('serve plan', () => {
  it('refuses a Funnel route and an unreadable config, and never plans to create over them', () => {
    expect(planServe({ state: 'funneled', ports: [443], port: 7444 }, 7787, null)).toMatchObject({
      refusal: expect.stringContaining('Funnel'),
    });
    expect(planServe({ state: 'unknown', reason: 'it timed out', port: 7443 }, 7787, null)).toMatchObject({
      refusal: expect.stringContaining('not changing the route'),
    });
  });

  it('creates a missing route and marks it created', () => {
    expect(planServe({ state: 'missing', port: 7444 }, 7787, null)).toEqual({
      record: { port: 7444, created: true },
      create: true,
    });
  });

  it('keeps an existing route, and remembers only a route an earlier install created', () => {
    expect(planServe({ state: 'routed', port: 7443 }, 7787, null)).toEqual({
      record: { port: 7443, created: false },
      create: false,
    });
    expect(planServe({ state: 'routed', port: 7443 }, 7787, { port: 7443, created: true })).toEqual({
      record: { port: 7443, created: true },
      create: false,
    });
    expect(planServe({ state: 'routed', port: 7444 }, 7787, { port: 7443, created: true })).toEqual({
      record: { port: 7444, created: false },
      create: false,
    });
  });
});

describe('launchctl print', () => {
  it('reads the top-level job fields and ignores nested state lines', () => {
    const output = [
      'gui/501/dev.stim.server = {',
      '\tactive count = 1',
      '\tstate = running',
      '',
      '\truns = 2',
      '\tpid = 518',
      '\tlast exit code = 1',
      '\tevent triggers = {',
      '\t\tstate = active',
      '\t}',
      '}',
    ].join('\n');
    expect(parseLaunchctlPrint(output)).toEqual({ state: 'running', pid: 518, runs: 2, lastExitCode: '1' });
    expect(parseLaunchctlPrint('\tstate = not running\n\tlast exit code = (never exited)')).toEqual({
      state: 'not running',
      pid: null,
      runs: null,
      lastExitCode: '(never exited)',
    });
  });
});

describe('service command line', () => {
  const stimServer = (...args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, PATH: '' }, encoding: 'utf8' });

  it('refuses outside macOS before touching anything', () => {
    if (process.platform === 'darwin') return;
    const result = stimServer('service', 'status');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runs only on macOS');
  });

  it('rejects flags that do not apply', () => {
    expect(stimServer('service', 'status', '--serve').stderr).toContain('only to `service install`');
    expect(stimServer('service', 'install', '--label', 'a/b').stderr).toContain('--label');
    expect(stimServer('service', 'install', '--env', 'X').stderr).toContain('KEY=VALUE');
    expect(stimServer('pair', '--label', 'x').stderr).toContain('only to `service`');
    expect(stimServer('service', 'restart').stderr).toContain('unknown command');
  });
});
