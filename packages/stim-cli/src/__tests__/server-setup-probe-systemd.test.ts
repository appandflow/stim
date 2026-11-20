import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUnit } from '../../../server/src/service-unit.ts';
import { readServerSetup } from '../diagnostics/server-setup-probe.ts';
import { serverSetupFindings } from '../diagnostics/server-setup.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

describe('doctor on a systemd unit that install wrote for the engine shim', () => {
  const platform = process.platform;
  let home: string;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const readUnit = async (
    edit: (text: string) => string,
    loadedKillMode = 'process',
    code = 'server-service-stale',
  ) => {
    home = mkdtempSync(join(tmpdir(), 'stim-probe-systemd-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('STIM_HOME', join(home, 'state'));
    const shim = join(home, 'engine', 'bin', 'stimd');
    const units = join(home, '.config', 'systemd', 'user');
    mkdirSync(units, { recursive: true });
    const text = renderUnit({
      label: 'dev.stim.server',
      host: null,
      node: '/usr/bin/node',
      script: join(home, 'npm', 'lib', 'node_modules', 'stim', 'bin', 'stim.mjs'),
      stimd: shim,
      port: 7787,
      env: [],
      pathPrepend: [],
      environment: { STIM_HOME: join(home, 'state') },
      logPath: join(home, 'server.log'),
      workingDirectory: home,
      serve: null,
    });
    writeFileSync(join(units, 'dev.stim.server.service'), edit(text));
    setExecutor({
      runFileQuiet: (file: string, argv: string[]) => {
        if (file === 'systemctl' && argv.includes('KillMode')) return `${loadedKillMode}\n`;
        if (file === 'systemctl' && argv.includes('show'))
          return 'ActiveState=active\nSubState=running\nMainPID=4242\nNRestarts=0\nExecMainStatus=0\n';
        if (file === 'loginctl') return 'yes\n';
        if (file === 'ps') return `4242 1 ${shim} --service --port 7787\n`;
        return null;
      },
    });
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const setup = await readServerSetup('2.0.0');
    Object.defineProperty(process, 'platform', { value: platform });
    expect(setup?.services.map((service) => service.label)).toEqual(['dev.stim.server']);
    return setup ? serverSetupFindings(setup).filter((finding) => finding.code === code) : [];
  };

  it('finds the shim unit install wrote and reports one written without KillMode=process', async () => {
    const [stale] = await readUnit((text) => text.replace('KillMode=process\n', ''));
    expect(stale?.detail).toMatch(/^Its unit sets no KillMode= where `stim service install` writes KillMode=process/);
    expect(stale?.fix).toContain(`STIM_HOME=${join(home, 'state')} stim service install --port 7787`);
  });

  it('reports nothing for a unit as install writes it', async () => {
    expect(await readUnit((text) => text)).toEqual([]);
    expect(await readUnit((text) => text, 'process', 'server-service-override')).toEqual([]);
  });

  it('names the drop-in when systemd has another KillMode loaded than the unit file sets', async () => {
    const [override] = await readUnit((text) => text, 'mixed', 'server-service-override');
    expect(override?.title).toContain('KillMode=mixed');
    expect(override?.detail).toMatch(/dev\.stim\.server\.service\.d\/.*keeps the successor handover/);
  });
});
