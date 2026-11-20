import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { renderUnit } from '../../../server/src/service-unit.ts';
import { serviceJob } from '../stimd/service-unit.ts';

describe('serviceJob on systemd', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-service-unit-'));
    vi.stubEnv('HOME', home);
    // Stands in for systemd: prints the KillMode it has loaded for the unit, or fails when there is none to print.
    mkdirSync(join(home, 'bin'));
    writeFileSync(
      join(home, 'bin', 'systemctl'),
      `#!/bin/sh\n[ -e '${home}/loaded-killmode' ] || exit 1\ncat '${home}/loaded-killmode'\n`,
    );
    chmodSync(join(home, 'bin', 'systemctl'), 0o755);
    vi.stubEnv('PATH', `${join(home, 'bin')}${delimiter}${process.env.PATH ?? ''}`);
    writeFileSync(join(home, 'loaded-killmode'), 'process\n');
    const dir = join(home, '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, '.stim', 'engine', 'bin'), { recursive: true });
    writeFileSync(join(home, '.stim', 'engine', 'bin', 'stimd'), '');
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
});
