import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  answersAs,
  applyServeEnvironment,
  parseEnvAssignment,
  parseInstalledPlist,
  renderPlist,
  argumentsWithScript,
  signatureProblem,
  validateServeEnvironment,
  type ServiceSpec,
} from '../src/service-plist.ts';
import { statusLines, updateService, type ServiceStatus } from '../src/service.ts';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { installHostApp, permissionPanes, unpackRelease } from '../src/stim-host.ts';

const SPEC: ServiceSpec = {
  label: 'dev.stim.server',
  host: null,
  node: '/opt/homebrew/bin/node',
  script: '/Users/me/stim & co/node_modules/@stim-cli/server/dist/stim-server.mjs',
  port: 7787,
  env: ['GEM_HOME=/gems', 'LANG=en_US.UTF-8', 'EXPO_TOKEN=s3cr&t<x>==y'],
  pathPrepend: ['/gems/bin'],
  environment: { STIM_HOME: '/tmp/scratch home', SHELL: '/bin/zsh' },
  logPath: '/Users/me/Library/Logs/Stim/dev.stim.server.log',
  workingDirectory: '/Users/me',
  serve: { port: 7443, created: true },
};

join(import.meta.dirname, '..', 'bin', 'stim-server.ts');

describe('service plist', () => {
  it('reads --env KEY=VALUE from the arguments of a plist written before values moved to EnvironmentVariables', () => {
    const legacy = parseInstalledPlist({
      Label: SPEC.label,
      ProgramArguments: [SPEC.node, SPEC.script, '--port', '7787', '--env', 'GEM_HOME=/gems', '--env', 'OPTS=a=b'],
      EnvironmentVariables: { STIM_HOME: '/tmp/scratch home' },
    });
    expect(legacy?.env).toEqual(['GEM_HOME=/gems', 'OPTS=a=b']);
  });

  describe.skipIf(process.platform !== 'darwin')('with plutil', () => {
    it.each([null, '/Users/me/Applications/Stim Host Dev.app/Contents/MacOS/stim-host'])(
      'reads back the launcher and server arguments for host %s',
      (host) => {
        const dir = mkdtempSync(join(tmpdir(), 'stim-service-plist-'));
        try {
          const file = join(dir, 'job.plist');
          writeFileSync(file, renderPlist({ ...SPEC, host }));
          const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
          expect(json).toMatchObject({ Label: SPEC.label, RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30 });
          expect(parseInstalledPlist(json)).toEqual({
            label: SPEC.label,
            host,
            node: SPEC.node,
            script: SPEC.script,
            port: 7787,
            env: SPEC.env,
            pathPrepend: SPEC.pathPrepend,
            stimHome: '/tmp/scratch home',
            logPath: SPEC.logPath,
            managed: true,
            serve: { port: 7443, created: true },
            previousScript: null,
            programArguments: [
              ...(host ? [host, 'run'] : []),
              SPEC.node,
              SPEC.script,
              ...json.ProgramArguments.slice(host ? 4 : 2),
            ],
          });
          const next =
            '/Users/me/Library/Application Support/Stim/services/dev.stim.server/versions/2.0.0-0123456789abcdef/node_modules/@stim-cli/server/dist/stim-server.mjs';
          const installed = parseInstalledPlist(json)!;
          execFileSync('plutil', [
            '-replace',
            'ProgramArguments',
            '-json',
            JSON.stringify(argumentsWithScript(installed, next)),
            file,
          ]);
          execFileSync('plutil', ['-replace', 'StimService.PreviousScript', '-string', SPEC.script, file]);
          const switched = parseInstalledPlist(
            JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })),
          );
          expect(switched).toEqual({
            ...installed,
            script: next,
            previousScript: SPEC.script,
            programArguments: argumentsWithScript(installed, next),
          });
          const without = join(dir, 'plain.plist');
          writeFileSync(without, renderPlist({ ...SPEC, serve: null }));
          execFileSync('plutil', ['-lint', without]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
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

  it('takes a bare --env KEY from the environment launchd gave the process', () => {
    const base = { PATH: '/usr/bin', EXPO_TOKEN: 'from-login-shell' };
    const source = { EXPO_TOKEN: 's3cret', OTHER: 'x' };
    expect(applyServeEnvironment(base, ['EXPO_TOKEN', 'MISSING'], [], source)).toEqual({
      PATH: '/usr/bin',
      EXPO_TOKEN: 's3cret',
    });
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

describe('service update checks', () => {
  it('tells two builds of one version apart by their Stim build, and matches an older server on its version', () => {
    const expected = { version: '1.14.0', stimBuild: 'aaaaaaaaaaaaaaaa' };
    expect(answersAs({ version: '1.14.0', stimBuild: 'aaaaaaaaaaaaaaaa' }, expected)).toBe(true);
    expect(answersAs({ version: '1.14.0', stimBuild: 'bbbbbbbbbbbbbbbb' }, expected)).toBe(false);
    expect(answersAs({ version: '1.13.0', stimBuild: 'aaaaaaaaaaaaaaaa' }, expected)).toBe(false);
    expect(answersAs({ version: '1.14.0' }, expected)).toBe(true);
    expect(
      answersAs({ version: '1.14.0', stimBuild: 'aaaaaaaaaaaaaaaa', startup: { state: 'degraded' } }, expected),
    ).toBe(false);
    expect(answersAs(null, expected)).toBe(false);
  });

  describe.skipIf(process.platform !== 'darwin')('on macOS', () => {
    it('refuses a second update of a label while one holds its claim', async () => {
      const home = mkdtempSync(join(tmpdir(), 'stim-service-claim-'));
      const previous = process.env.HOME;
      process.env.HOME = home;
      try {
        mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
        writeFileSync(join(home, 'Library', 'LaunchAgents', 'dev.stim.claimed.plist'), renderPlist(SPEC));
        const held = tryAcquireClaim({
          root: join(home, 'Library', 'Application Support', 'Stim', 'services', 'dev.stim.claimed', 'update.claims'),
          mode: 'exclusive',
        });
        expect(held.acquired).toBeDefined();
        await expect(updateService('dev.stim.claimed', { release: '1.14.0' }, () => {})).rejects.toThrow(
          'An install, update or rollback of dev.stim.claimed is running',
        );
        releaseClaim(held.acquired);
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('accepts only an npm signature report that vouches for every package', () => {
    expect(signatureProblem('{"invalid":[],"missing":[]}')).toBeNull();
    expect(
      signatureProblem(
        JSON.stringify({ invalid: [{ name: 'stim', version: '1.14.0', code: 'EINTEGRITYSIGNATURE' }], missing: [] }),
      ),
    ).toContain('invalid registry signatures or attestations: stim@1.14.0');
    expect(signatureProblem(JSON.stringify({ invalid: [], missing: [{ name: 'ws', version: '8.0.0' }] }))).toContain(
      'without registry signatures: ws@8.0.0',
    );
    expect(signatureProblem('npm ERR! audit signatures failed')).toContain('did not print a JSON report');
    const failure = signatureProblem(
      JSON.stringify({
        error: { code: 'ETARGET', summary: 'No matching version found for stim@99.0.0.', detail: 'Pick a version.' },
      }),
    );
    expect(failure).toContain('No matching version found for stim@99.0.0.');
    expect(failure).toContain('Pick a version.');
    expect(signatureProblem('', 'npm error first\nnpm error found no installed dependencies to audit')).toContain(
      'npm error found no installed dependencies to audit',
    );
  });
});

describe('service status permissions', () => {
  const status: ServiceStatus = {
    label: SPEC.label,
    manager: 'launchd',
    installed: true,
    plist: '/Users/me/Library/LaunchAgents/dev.stim.server.plist',
    loaded: false,
    state: null,
    pid: null,
    runs: null,
    lastExitCode: null,
    port: SPEC.port,
    health: null,
    serve: null,
    logPath: SPEC.logPath,
    node: SPEC.node,
    script: SPEC.script,
    previousScript: null,
    host: {
      app: '/Users/me/Applications/Stim Host Dev.app',
      name: 'Stim Host Dev',
      screenRecording: true,
      accessibility: false,
    },
    envNames: [],
    pathPrepend: [],
    stimBuild: { service: null, cli: null, match: null },
    linger: null,
  };

  const line = (lines: string[], prefix: string) => lines.find((each) => each.startsWith(`  ${prefix}`)) ?? '';

  it('keeps unreported grants unknown instead of claiming access was denied', () => {
    const lines = statusLines(
      { ...status, host: { ...status.host!, screenRecording: null, accessibility: null } },
      permissionPanes(14),
    );
    expect(line(lines, 'Screen Recording:')).toContain('unknown');
    expect(line(lines, 'Accessibility:')).toContain('unknown');
  });

  it('reports a server that listens but cannot read its Stim home as degraded, not ok', () => {
    const health = {
      startup: { state: 'ready' as const },
      version: '1',
      stim: '1',
      stimHome: '/h',
      tailscale: null,
      route: null,
    };
    expect(line(statusLines({ ...status, health }, permissionPanes(27)), 'health:')).toMatch(/^ {2}health: ok,/);
    const degraded = { ...health, startup: { state: 'degraded' as const, reason: 'A read did not finish.' } };
    expect(line(statusLines({ ...status, health: degraded }, permissionPanes(27)), 'health:')).toMatch(
      /^ {2}health: degraded.*A read did not finish\./,
    );
    const pending = { ...health, startup: { state: 'pending' as const } };
    expect(line(statusLines({ ...status, health: pending }, permissionPanes(27)), 'health:')).toMatch(
      /^ {2}health: starting/,
    );
  });

  it('points a node-first service at reinstalling', () => {
    expect(statusLines({ ...status, host: null }, permissionPanes(27)).join('\n')).toContain(
      '`stim-server service install` again',
    );
  });
});

describe('host app', () => {
  describe.skipIf(process.platform !== 'darwin')('install', () => {
    let home: string;
    let previousHome: string | undefined;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'stim-host-home-'));
      previousHome = process.env.HOME;
      process.env.HOME = home;
    });
    afterEach(() => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    });

    it('keeps an identical bundle, removes abandoned builds and refuses a bundle it does not own', async () => {
      const sources = join(import.meta.dirname, '..', 'host');
      const applications = join(home, 'Applications');
      const first = await installHostApp(sources, null);
      expect(first).toMatchObject({ bundleId: 'dev.stim.host.dev', replaced: true });
      execFileSync('codesign', ['--verify', '--strict', first.app]);
      const abandoned = join(applications, '.Stim Host Dev.app.999999.tmp-x');
      mkdirSync(abandoned);
      expect((await installHostApp(sources, null)).replaced).toBe(false);
      expect(readdirSync(applications)).toEqual(['Stim Host Dev.app']);
      writeFileSync(
        join(first.app, 'Contents', 'Info.plist'),
        '<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>',
      );
      await expect(installHostApp(sources, null)).rejects.toThrow(/not a Stim Host Dev bundle/);
    }, 120_000);

    it('refuses a release zip that does not match the pin or lacks the Developer ID signature', async () => {
      const app = join(home, 'build', 'Stim Host.app');
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
      execFileSync('cp', ['/usr/bin/true', join(app, 'Contents', 'MacOS', 'stim-host')]);
      writeFileSync(
        join(app, 'Contents', 'Info.plist'),
        readFileSync(join(import.meta.dirname, '..', 'host', 'Info.plist')),
      );
      execFileSync('codesign', ['--force', '--sign', '-', app]);
      const archive = join(home, 'StimHost.zip');
      execFileSync('ditto', ['-c', '-k', '--keepParent', app, archive]);
      const zip = readFileSync(archive);
      const sha256 = createHash('sha256').update(zip).digest('hex');
      const unpack = (pin: string) => unpackRelease(zip, pin, mkdtempSync(join(home, 'unpack-')));
      await expect(unpack('0'.repeat(64))).rejects.toThrow(/SHA-256/);
      await expect(unpack(sha256)).rejects.toThrow(/not signed by App & Flow's Developer ID/);
    });
  });
});
