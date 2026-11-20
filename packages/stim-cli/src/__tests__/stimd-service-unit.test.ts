import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { renderUnit } from '../../../server/src/service-unit.ts';
import { deferringService, serviceJob, startServiceJob } from '../stimd/service-unit.ts';

describe('serviceJob on systemd', () => {
  let home: string;
  const shim = (build: string) => `#!/bin/sh\nexec node "/engine/${build}/dist/cli.mjs" __stimd "$@"\n`;
  /** What `systemctl show` prints for the loaded unit. */
  const showLoaded = ({
    active = 'ActiveState=active\nSubState=running',
    stimHome = join(home, '.stim'),
    restart = '30s',
  }: { active?: string; stimHome?: string; restart?: string } = {}) => {
    const stimd = join(home, '.stim', 'engine', 'bin', 'stimd');
    writeFileSync(
      join(home, 'unit-state'),
      `${active}\nRestartUSec=${restart}\nEnvironment=STIM_HOME=${stimHome} STIM_SERVICE_LABEL=dev.stim.server\n` +
        `ExecStart={ path=${stimd} ; argv[]=${stimd} --service --port 7787 ; ignore_errors=no ; start_time=[n/a] }\n`,
    );
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-service-unit-'));
    vi.stubEnv('HOME', home);
    // Stands in for systemd: prints the KillMode it has loaded for the unit, or fails when there is none to print.
    mkdirSync(join(home, 'bin'));
    writeFileSync(
      join(home, 'bin', 'systemctl'),
      `#!/bin/sh
case "$*" in
  *KillMode*) [ -e '${home}/loaded-killmode' ] || exit 1; cat '${home}/loaded-killmode' ;;
  *ActiveState*) cat '${home}/unit-state' ;;
  *) echo "$*" >> '${home}/started' ;;
esac
`,
    );
    showLoaded();
    chmodSync(join(home, 'bin', 'systemctl'), 0o755);
    vi.stubEnv('PATH', `${join(home, 'bin')}${delimiter}${process.env.PATH ?? ''}`);
    writeFileSync(join(home, 'loaded-killmode'), 'process\n');
    const dir = join(home, '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, '.stim', 'engine', 'bin'), { recursive: true });
    writeFileSync(join(home, '.stim', 'engine', 'bin', 'stimd'), shim('b1'));
    writeFileSync(
      join(home, '.stim', 'engine', 'current.json'),
      JSON.stringify({ format: 1, dir: 'b1', version: 'b1' }),
    );
    writeFileSync(
      join(dir, 'dev.stim.server.service'),
      renderUnit({
        label: 'dev.stim.server',
        host: null,
        node: '/usr/bin/node',
        script: join(home, '.stim', 'engine', 'bin', 'stimd'),
        stimd: join(home, '.stim', 'engine', 'bin', 'stimd'),
        port: 7787,
        env: [],
        pathPrepend: [],
        environment: {},
        logPath: join(home, 'server.log'),
        workingDirectory: home,
        serve: null,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ['the unit install wrote for this port', { STIM_SERVICE_LABEL: 'dev.stim.server' }, 7787, 'dev.stim.server'],
    ['that unit for another port', { STIM_SERVICE_LABEL: 'dev.stim.server' }, 7788, null],
    ['a label with no unit file', { STIM_SERVICE_LABEL: 'dev.stim.other' }, 7787, null],
    ['no label, as outside a unit', {}, 7787, null],
  ])('marks a process started by %s', (_case, env, port, expected) => {
    expect(serviceJob(env, port, null, 'linux')?.label ?? null).toBe(expected);
  });

  it.each([
    ['the engine whose shim the unit runs', ['.stim', 'engine'], true],
    ['another engine', ['other-engine'], false],
  ])('says whether the job follows %s', (_case, root, expected) => {
    expect(serviceJob({ STIM_SERVICE_LABEL: 'dev.stim.server' }, 7787, join(home, ...root), 'linux')).toEqual({
      label: 'dev.stim.server',
      followsEngine: expected,
    });
  });

  it.each([
    ['systemd has its default loaded, as for a unit written without KillMode=process', 'control-group\n'],
    ['a drop-in overrides the unit file with another mode', 'mixed\n'],
    ['systemctl cannot say', null],
  ])('does not follow the engine when %s, since its exit would kill its children', (_case, loaded) => {
    if (loaded === null) rmSync(join(home, 'loaded-killmode'));
    else writeFileSync(join(home, 'loaded-killmode'), loaded);
    expect(serviceJob({ STIM_SERVICE_LABEL: 'dev.stim.server' }, 7787, join(home, '.stim', 'engine'), 'linux')).toEqual(
      { label: 'dev.stim.server', followsEngine: false },
    );
  });

  describe('deferringService', () => {
    const record = (value: object) => {
      mkdirSync(join(home, '.stim', 'run'), { recursive: true });
      writeFileSync(join(home, '.stim', 'run', 'service.json'), JSON.stringify(value));
    };
    const defers = (env: NodeJS.ProcessEnv = {}, root = join(home, '.stim', 'engine')) =>
      deferringService(join(home, '.stim'), root, env, 'linux');

    beforeEach(() => record({ label: 'dev.stim.server', port: 7787 }));

    it.each([
      ['runs', 'ActiveState=active\nSubState=running'],
      ['waits to restart', 'ActiveState=activating\nSubState=auto-restart'],
    ])('leaves the home to a unit that follows the engine and whose job %s', (_case, active) => {
      showLoaded({ active });
      expect(defers()?.label).toBe('dev.stim.server');
    });

    it.each([
      ['30s', 75_000],
      ['1min 30s', 135_000],
      ['100ms', 45_100],
    ])('waits for a unit with RestartSec %s through its restart delay and a boot', (restart, waitMs) => {
      showLoaded({ restart });
      expect(defers()).toEqual({ label: 'dev.stim.server', waitMs });
    });

    it.each([
      ['the user stopped the unit', () => showLoaded({ active: 'ActiveState=inactive\nSubState=dead' })],
      ['a drop-in moves the loaded unit to another Stim home', () => showLoaded({ stimHome: join(home, 'other') })],
      [
        'the engine selected a build its shim does not start yet',
        () => writeFileSync(join(home, '.stim', 'engine', 'current.json'), JSON.stringify({ format: 1, dir: 'b2' })),
      ],
      ['no unit is recorded', () => rmSync(join(home, '.stim', 'run', 'service.json'))],
      ['the recorded port is not the unit port', () => record({ label: 'dev.stim.server', port: 7788 })],
      ['the unit file is gone', () => rmSync(join(home, '.config', 'systemd', 'user', 'dev.stim.server.service'))],
      ['systemd kills the children of the unit', () => writeFileSync(join(home, 'loaded-killmode'), 'control-group\n')],
    ])('boots as before when %s', (_case, change) => {
      mkdirSync(join(home, 'other'), { recursive: true });
      change();
      expect(defers()).toBeNull();
    });

    it('boots as before in a Stim home the unit does not serve', () => {
      const other = join(home, 'other');
      mkdirSync(join(other, 'run'), { recursive: true });
      writeFileSync(join(other, 'run', 'service.json'), JSON.stringify({ label: 'dev.stim.server', port: 7787 }));
      expect(deferringService(other, join(home, '.stim', 'engine'), {}, 'linux')).toBeNull();
    });

    it('boots as before when the unit does not run the shim of this engine', () => {
      expect(defers({}, join(home, 'other-engine'))).toBeNull();
    });

    it('never leaves the home to the job the process runs in', () => {
      expect(defers({ STIM_SERVICE_LABEL: 'dev.stim.server' })).toBeNull();
    });

    it.each([
      ['engine', 'my home'],
      ['eng ine', 'my home'],
    ])(
      'reads what systemd 255 prints for a unit whose shim is under %j and whose Stim home is %j',
      (engineDir, homeDir) => {
        const root = join(home, engineDir);
        const stimHome = join(home, homeDir);
        const stimd = join(root, 'bin', 'stimd');
        mkdirSync(join(root, 'bin'), { recursive: true });
        writeFileSync(stimd, shim('b1'));
        writeFileSync(join(root, 'current.json'), JSON.stringify({ format: 1, dir: 'b1', version: 'b1' }));
        mkdirSync(join(stimHome, 'run'), { recursive: true });
        writeFileSync(join(stimHome, 'run', 'service.json'), JSON.stringify({ label: 'dev.stim.server', port: 17787 }));
        writeFileSync(
          join(home, '.config', 'systemd', 'user', 'dev.stim.server.service'),
          renderUnit({
            label: 'dev.stim.server',
            host: null,
            node: '/usr/bin/node',
            script: stimd,
            stimd,
            port: 17787,
            env: ['TOKEN', 'JAVA_HOME'],
            pathPrepend: ['/opt/android sdk/platform-tools', '/usr/local/bin'],
            environment: { STIM_HOME: stimHome },
            logPath: join(home, 'server.log'),
            workingDirectory: home,
            serve: null,
          }),
        );
        // The output of `systemctl --user show -p ActiveState -p SubState -p RestartUSec -p Environment -p ExecStart`
        // captured from systemd 255 on Ubuntu, with this test's paths.
        writeFileSync(
          join(home, 'unit-state'),
          [
            'RestartUSec=30s',
            `ExecStart={ path=${stimd} ; argv[]=${stimd} --service --port 17787 --env TOKEN --env JAVA_HOME --path-prepend /opt/android sdk/platform-tools --path-prepend /usr/local/bin ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
            `Environment="STIM_HOME=${stimHome}" SHELL=/bin/bash "TOKEN=a\\"b\\\\c%d\\$e f" "JAVA_HOME=/usr/lib/jvm/java 17" STIM_SERVICE_LABEL=dev.stim.server`,
            'ActiveState=activating',
            'SubState=auto-restart',
            '',
          ].join('\n'),
        );
        expect(deferringService(stimHome, root, {}, 'linux')).toEqual({ label: 'dev.stim.server', waitMs: 75_000 });
      },
    );

    it('starts the unit through systemctl', () => {
      startServiceJob('dev.stim.server', 'linux');
      expect(readFileSync(join(home, 'started'), 'utf8')).toBe('--user start --no-block dev.stim.server.service\n');
    });
  });
});
