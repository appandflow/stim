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
import * as processIdentity from '@stim-cli/core/process-identity';
import { delimiter, join } from 'node:path';
import { addUnitKillMode, holdingServiceClaim, migrateUnitAtBoot, rewriteUnitToShim } from '../src/service.ts';
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
    // Stands in for systemd: `show` prints the ExecStart and KillMode it loaded at the last `daemon-reload` (or at the
    // start), the unit's drop-ins included. `fail` holds how many reloads fail; `mutate` makes a failing reload rewrite the unit.
    writeFileSync(
      join(bin, 'systemctl'),
      `#!/bin/sh
case "$*" in
  *daemon-reload*)
    echo reload >> '${home}/reloads'
    if [ -e '${home}/fail' ]; then
      n=$(cat '${home}/fail'); n=\${n:-1}
      if [ "$n" -gt 1 ]; then echo $((n - 1)) > '${home}/fail'; else rm '${home}/fail'; fi
      if [ -e '${home}/mutate' ]; then echo '# edited' >> '${unit}'; fi
      echo 'bus unavailable' >&2; exit 1
    fi
    grep '^ExecStart=' '${unit}' > '${home}/loaded'
    mode=$(cat '${unit}' '${unit}'.d/*.conf 2>/dev/null | sed -n 's/^KillMode *= *//p' | tail -1)
    echo "\${mode:-control-group}" > '${home}/loaded-killmode' ;;
  *KillMode*)
    cat '${home}/loaded-killmode' ;;
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
    // The service claim reads this process's identity, which needs the real platform's process table.
    const onHost =
      <A extends unknown[], R>(read: (...args: A) => R) =>
      (...args: A): R => {
        Object.defineProperty(process, 'platform', { value: platform });
        try {
          return read(...args);
        } finally {
          Object.defineProperty(process, 'platform', { value: 'linux' });
        }
      };
    const { captureProcessIdentity, inspectProcessIdentity } = processIdentity;
    vi.spyOn(processIdentity, 'captureProcessIdentity').mockImplementation(onHost(captureProcessIdentity));
    vi.spyOn(processIdentity, 'inspectProcessIdentity').mockImplementation(onHost(inspectProcessIdentity));
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
    writeFileSync(join(home, 'loaded-killmode'), 'process\n');
    shim = join(home, 'engine', 'bin', 'stimd');
    mkdirSync(join(home, 'engine', 'bin'), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.restoreAllMocks();
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

  describe('KillMode=process', () => {
    const written = `[Unit]
Description=stim-server (${label})

[Service]
ExecStart="/usr/bin/node" "/old/stim-server.mjs" "serve" "--service" "--port" "7787"
Environment="STIM_SERVICE_LABEL=${label}"
Restart=always

[X-Stim]
Managed=true
`;
    const migrated = written.replace('[Service]\n', '[Service]\nKillMode=process\n');
    const loadedKillMode = () => readFileSync(join(home, 'loaded-killmode'), 'utf8').trim();

    beforeEach(() => {
      writeFileSync(unit, written);
      writeFileSync(join(home, 'loaded-killmode'), 'control-group\n');
    });

    it('is added once to a unit written without it and loaded by systemd without a restart', async () => {
      await addUnitKillMode(label);
      expect(readFileSync(unit, 'utf8')).toBe(migrated);
      expect(loadedKillMode()).toBe('process');
      expect(reloads()).toBe('reload\n');
      await addUnitKillMode(label);
      expect(reloads()).toBe('reload\n');
    });

    it('restores the unit byte for byte when the reload fails, and the next call adds it', async () => {
      const original = Buffer.from(written.replace('serve', 'serv\u00e9'), 'utf8');
      writeFileSync(unit, original);
      writeFileSync(join(home, 'fail'), '');
      await expect(addUnitKillMode(label)).rejects.toThrow(/did not reload.*bus unavailable.*unchanged/);
      expect(readFileSync(unit).equals(original)).toBe(true);
      await addUnitKillMode(label);
      expect(readFileSync(unit, 'utf8')).toContain('[Service]\nKillMode=process\n');
      expect(loadedKillMode()).toBe('process');
      expect(reloads()).toBe('reload\nreload\n');
    });

    it('leaves a unit that changed during a failed reload as it is now', async () => {
      writeFileSync(join(home, 'fail'), '');
      writeFileSync(join(home, 'mutate'), '');
      await expect(addUnitKillMode(label)).rejects.toThrow(/did not reload.*changed since/);
      expect(readFileSync(unit, 'utf8')).toBe(`${migrated}# edited\n`);
    });

    it('skips a unit that is not UTF-8 text', async () => {
      const original = Buffer.concat([Buffer.from(written, 'utf8'), Buffer.from([0xff, 0x0a])]);
      writeFileSync(unit, original);
      await expect(addUnitKillMode(label)).rejects.toThrow(/not UTF-8/);
      expect(readFileSync(unit).equals(original)).toBe(true);
      expect(reloads()).toBe('');
    });

    it('skips a unit install did not write', async () => {
      const foreign = written.replace('[X-Stim]\nManaged=true\n', '');
      writeFileSync(unit, foreign);
      await addUnitKillMode(label);
      expect(readFileSync(unit, 'utf8')).toBe(foreign);
      expect(reloads()).toBe('');
    });

    it('keeps a mode the unit sets, however it is spaced', async () => {
      const mixed = written.replace('Restart=always', 'Restart=always\nKillMode = mixed');
      writeFileSync(unit, mixed);
      await addUnitKillMode(label);
      expect(readFileSync(unit, 'utf8')).toBe(mixed);
      expect(reloads()).toBe('');
    });

    it('reloads a unit whose file says process while systemd has another mode loaded', async () => {
      writeFileSync(unit, migrated.replace('KillMode=process', 'KillMode = process'));
      await addUnitKillMode(label);
      expect(loadedKillMode()).toBe('process');
      expect(reloads()).toBe('reload\n');
    });

    it('reports a drop-in that overrides it after a successful reload', async () => {
      mkdirSync(`${unit}.d`);
      writeFileSync(join(`${unit}.d`, 'override.conf'), '[Service]\nKillMode=mixed\n');
      await expect(addUnitKillMode(label)).rejects.toThrow(/KillMode=mixed loaded.*successor handover/);
      expect(readFileSync(unit, 'utf8')).toBe(migrated);
      expect(loadedKillMode()).toBe('mixed');
    });

    it('waits for no install: a held service claim leaves the unit for the next boot', async () => {
      await holdingServiceClaim(label, async () => {
        await expect(addUnitKillMode(label)).rejects.toThrow(/is running/);
      });
      expect(readFileSync(unit, 'utf8')).toBe(written);
    });
  });

  describe('boot migrations', () => {
    beforeEach(() => {
      writeFileSync(unit, readFileSync(unit, 'utf8').replace('KillMode=process\n', ''));
      writeFileSync(join(home, 'loaded-killmode'), 'control-group\n');
    });

    it('asks for the shim restart when the KillMode reload loads a shim whose own reload failed', async () => {
      writeFileSync(join(home, 'fail'), '1');
      const reports: string[] = [];
      expect(await migrateUnitAtBoot(label, (message) => reports.push(message))).toBe(true);
      expect(reports).toEqual([expect.stringMatching(/has not loaded the engine shim/)]);
      expect(readFileSync(unit, 'utf8')).toContain('KillMode=process');
    });

    it('asks for the shim restart on the next boot when both reloads failed', async () => {
      writeFileSync(join(home, 'fail'), '2');
      const reports: string[] = [];
      expect(await migrateUnitAtBoot(label, (message) => reports.push(message))).toBe(false);
      expect(reports).toEqual([
        expect.stringMatching(/has not loaded the engine shim/),
        expect.stringMatching(/did not reload/),
      ]);
      expect(await migrateUnitAtBoot(label, (message) => reports.push(message))).toBe(true);
      expect(reports).toHaveLength(2);
      expect(await migrateUnitAtBoot(label, (message) => reports.push(message))).toBe(false);
    });
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
