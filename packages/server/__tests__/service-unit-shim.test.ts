import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { serviceStale, serviceStatus } from '../src/service.ts';
import { renderUnit } from '../src/service-unit.ts';
import type { ServiceSpec } from '../src/service-plist.ts';

describe('systemd unit pinned to a server script', () => {
  const platform = process.platform;
  const label = 'dev.stim.server';
  let home: string;
  let unit: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-unit-shim-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    unit = join(home, '.config', 'systemd', 'user', `${label}.service`);
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(
      join(bin, 'systemctl'),
      `#!/bin/sh
case "$*" in
  *show*)
    sed -E 's/^ExecStart="([^"]*)".*/ExecStart={ path=\\1 ; argv[]=\\1 ; }/' '${home}/loaded' ;;
esac
`,
    );
    chmodSync(join(bin, 'systemctl'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', home);
    vi.stubEnv('STIM_ENGINE_ROOT', join(home, 'engine'));
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const spec: ServiceSpec = {
      label,
      host: null,
      node: '/usr/bin/node',
      script: '/old/stim-server.mjs',
      port: 7787,
      env: ['ANDROID_HOME=/sdk'],
      pathPrepend: ['/jdk/bin'],
      environment: { STIM_HOME: join(home, '.stim') },
      logPath: join(home, 'log'),
      workingDirectory: home,
      serve: null,
    };
    writeFileSync(unit, renderUnit(spec));
    writeFileSync(
      join(home, 'loaded'),
      readFileSync(unit, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('ExecStart=')) + '\n',
    );
    const shim = join(home, 'engine', 'bin', 'stimd');
    mkdirSync(join(home, 'engine', 'bin'), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('names the install for a unit that names node while the engine store has the shim, and boots it unchanged', async () => {
    const before = readFileSync(unit, 'utf8');
    const stale = await serviceStale(label);
    expect(stale?.reason).toBe("its unit does not start the engine's stimd shim");
    expect(stale?.remedy).toContain('stim service install --port 7787');
    expect(readFileSync(unit, 'utf8')).toBe(before);
    rmSync(join(home, 'engine'), { recursive: true });
    expect(await serviceStale(label)).toBeNull();
  });

  it('names the install that writes KillMode=process for a unit install wrote without it, and nothing otherwise', async () => {
    rmSync(join(home, 'engine'), { recursive: true });
    expect(await serviceStale(label)).toBeNull();
    const current = readFileSync(unit, 'utf8');
    writeFileSync(unit, current.replace('KillMode=process\n', ''));
    const stale = await serviceStale(label);
    expect(stale?.reason).toMatch(/sets no KillMode=/);
    expect(stale?.remedy).toBe(
      `run \`STIM_HOME=${join(home, '.stim')} stim service install --port 7787 --path-prepend /jdk/bin --env ANDROID_HOME=<value>\` once when no build runs, with each <value> set to what the service sets now`,
    );
    expect((await serviceStatus(label)).stale).toEqual(stale);
    writeFileSync(unit, current.replace('KillMode=process\n', '').replace('[X-Stim]\nManaged=true\n', ''));
    expect(await serviceStale(label)).toBeNull();
  });
});
