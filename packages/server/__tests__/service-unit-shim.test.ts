import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { rewriteUnitToShim } from '../src/service.ts';
import { renderUnit } from '../src/service-unit.ts';
import type { ServiceSpec } from '../src/service-plist.ts';

describe('systemd unit pinned to a server script', () => {
  const platform = process.platform;
  let home: string;
  let reloads: string;
  let unit: string;
  const label = 'dev.stim.server';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-unit-shim-'));
    reloads = join(home, 'systemctl.log');
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> '${reloads}'\n`);
    chmodSync(join(bin, 'systemctl'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', home);
    vi.stubEnv('STIM_ENGINE_ROOT', join(home, 'engine'));
    Object.defineProperty(process, 'platform', { value: 'linux' });
    unit = join(home, '.config', 'systemd', 'user', `${label}.service`);
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
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
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('is rewritten to the engine shim once, then reloaded by systemd without a restart', async () => {
    const shim = join(home, 'engine', 'bin', 'stimd');
    mkdirSync(join(home, 'engine', 'bin'), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
    const before = readFileSync(unit, 'utf8');
    expect(await rewriteUnitToShim(label)).toBe(true);
    const after = readFileSync(unit, 'utf8');
    expect(after).toContain(
      `ExecStart="${shim}" "--service" "--port" "7787" "--env" "ANDROID_HOME" "--path-prepend" "/jdk/bin"`,
    );
    expect(after.replace(/^ExecStart=.*\n/m, '')).toBe(before.replace(/^ExecStart=.*\n/m, ''));
    expect(readFileSync(reloads, 'utf8')).toBe('--user daemon-reload\n');
    expect(await rewriteUnitToShim(label)).toBe(false);
    expect(readFileSync(reloads, 'utf8')).toBe('--user daemon-reload\n');
  });

  it('stays as written when the machine has no engine store', async () => {
    const before = readFileSync(unit, 'utf8');
    expect(await rewriteUnitToShim(label)).toBe(false);
    expect(readFileSync(unit, 'utf8')).toBe(before);
  });
});
