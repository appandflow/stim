import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { rewriteUnitToShim, serviceStale, serviceStatus } from '../src/service.ts';
import { renderUnit } from '../src/service-unit.ts';
import type { ServiceSpec } from '../src/service-plist.ts';

describe('systemd unit pinned to a server script', () => {
  const platform = process.platform;
  const label = 'dev.stim.server';
  let home: string;
  let unit: string;
  let shim: string;

  const reloads = () => (existsSync(join(home, 'reloads')) ? readFileSync(join(home, 'reloads'), 'utf8') : '');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-unit-shim-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    unit = join(home, '.config', 'systemd', 'user', `${label}.service`);
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    // Stands in for systemd: `show` prints the ExecStart it loaded at the last `daemon-reload` (or at the start).
    writeFileSync(
      join(bin, 'systemctl'),
      `#!/bin/sh
case "$*" in
  *daemon-reload*)
    echo reload >> '${home}/reloads'
    if [ -e '${home}/fail' ]; then rm '${home}/fail'; echo 'bus unavailable' >&2; exit 1; fi
    grep '^ExecStart=' '${unit}' > '${home}/loaded' ;;
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
    shim = join(home, 'engine', 'bin', 'stimd');
    mkdirSync(join(home, 'engine', 'bin'), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('is rewritten to the engine shim once and loaded by systemd without a restart', async () => {
    const before = readFileSync(unit, 'utf8');
    expect(await rewriteUnitToShim(label)).toBe(true);
    const after = readFileSync(unit, 'utf8');
    expect(after).toContain(
      `ExecStart="${shim}" "--service" "--port" "7787" "--env" "ANDROID_HOME" "--path-prepend" "/jdk/bin"`,
    );
    expect(after.replace(/^ExecStart=.*\n/m, '')).toBe(before.replace(/^ExecStart=.*\n/m, ''));
    expect(reloads()).toBe('reload\n');
    expect(await rewriteUnitToShim(label)).toBe(false);
    expect(reloads()).toBe('reload\n');
  });

  it('retries a failed reload on the next call until systemd has loaded the shim, then asks for a restart once', async () => {
    writeFileSync(join(home, 'fail'), '');
    await expect(rewriteUnitToShim(label)).rejects.toThrow(
      /has not loaded the engine shim.*bus unavailable.*daemon-reload/,
    );
    expect(readFileSync(unit, 'utf8')).toContain(`ExecStart="${shim}"`);
    expect(await rewriteUnitToShim(label)).toBe(true);
    expect(reloads()).toBe('reload\nreload\n');
    expect(await rewriteUnitToShim(label)).toBe(false);
  });

  it('stays as written when the machine has no engine store', async () => {
    rmSync(join(home, 'engine'), { recursive: true });
    const before = readFileSync(unit, 'utf8');
    expect(await rewriteUnitToShim(label)).toBe(false);
    expect(readFileSync(unit, 'utf8')).toBe(before);
  });

  it('refuses a drop-in that sets ExecStart= and a multi-line ExecStart=, leaving the unit as written', async () => {
    const before = readFileSync(unit, 'utf8');
    mkdirSync(`${unit}.d`);
    writeFileSync(join(`${unit}.d`, 'override.conf'), '[Service]\nExecStart=\nExecStart=/bin/true\n');
    await expect(rewriteUnitToShim(label)).rejects.toThrow(/override\.conf sets ExecStart=/);
    rmSync(`${unit}.d`, { recursive: true });
    writeFileSync(unit, before.replace(/^(ExecStart=.*)$/m, '$1 \\\n  "--extra"'));
    const continued = readFileSync(unit, 'utf8');
    await expect(rewriteUnitToShim(label)).rejects.toThrow(/not one single line/);
    expect(readFileSync(unit, 'utf8')).toBe(continued);
    expect(reloads()).toBe('');
  });

  it('names the install that writes KillMode=process for a unit install wrote without it, and nothing otherwise', async () => {
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

  it('writes through a symlinked unit instead of replacing the link', async () => {
    const real = join(home, 'dotfiles.service');
    writeFileSync(real, readFileSync(unit, 'utf8'));
    rmSync(unit);
    symlinkSync(real, unit);
    expect(await rewriteUnitToShim(label)).toBe(true);
    expect(readFileSync(real, 'utf8')).toContain(`ExecStart="${shim}"`);
    expect(readFileSync(unit, 'utf8')).toBe(readFileSync(real, 'utf8'));
  });
});
