import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUnit } from '../../../server/src/service-unit.ts';
import { startedByServiceUnit } from '../stimd/service-unit.ts';

describe('startedByServiceUnit on systemd', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-service-unit-'));
    vi.stubEnv('HOME', home);
    const dir = join(home, '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
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
    ['the unit install wrote for this port', { STIM_SERVICE_LABEL: 'dev.stim.server' }, 7787, true],
    ['that unit for another port', { STIM_SERVICE_LABEL: 'dev.stim.server' }, 7788, false],
    ['a label with no unit file', { STIM_SERVICE_LABEL: 'dev.stim.other' }, 7787, false],
    ['no label, as outside a unit', {}, 7787, false],
  ])('marks a process started by %s', (_case, env, port, expected) => {
    expect(startedByServiceUnit(env, port, 'linux')).toBe(expected);
  });
});
