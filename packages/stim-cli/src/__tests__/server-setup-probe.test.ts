import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPlist } from '@stim-cli/server/service-plist';
import { readServerSetup } from '../diagnostics/server-setup-probe.ts';
import { serverPermissionFindings } from '../diagnostics/server-permissions.ts';
import { serverSetupFindings } from '../diagnostics/server-setup.ts';
import { getExecutor, resetExecutor, setExecutor, type ExecOptions } from '../exec.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const sdk = '/Volumes/ExternalSSD/Android/sdk';
  return {
    ...fs,
    realpathSync: (...args: Parameters<typeof fs.realpathSync>) => (args[0] === sdk ? sdk : fs.realpathSync(...args)),
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      if (args[0] === sdk) throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      return fs.readdirSync(...args);
    },
  };
});

describe.skipIf(process.platform !== 'darwin')('doctor on a LaunchAgent that install wrote for the engine shim', () => {
  let home: string;
  let labels: string[] = [];
  afterEach(() => {
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  /** Writes the default unit for the shim, optionally under Stim Host, and answers `launchctl print` with `loaded`. */
  const readUnit = async (
    withHost: boolean,
    loaded: (node: string, script: string, args: string[]) => string[],
    { binary = false, unmanaged = false } = {},
  ) => {
    home = mkdtempSync(join(tmpdir(), 'stim-probe-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('STIM_HOME', join(home, 'state'));
    vi.stubEnv('STIM_ENGINE_ROOT', join(home, 'engine'));
    const shim = join(home, 'engine', 'bin', 'stimd');
    mkdirSync(join(home, 'engine', 'bin'), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
    const host = join(home, 'Applications', 'Stim Host.app', 'Contents', 'MacOS', 'stim-host');
    mkdirSync(join(host, '..'), { recursive: true });
    writeFileSync(host, '', { mode: 0o755 });
    const agents = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    const spec = {
      label: 'dev.stim.server',
      host: withHost ? host : null,
      node: process.execPath,
      script: unmanaged
        ? join(home, 'npm', 'lib', 'node_modules', '@stim-cli', 'server', 'dist', 'stim-server.mjs')
        : join(home, 'npm', 'lib', 'node_modules', 'stim', 'bin', 'stim.mjs'),
      port: 7787,
      env: [],
      pathPrepend: [],
      environment: { STIM_HOME: join(home, 'state') },
      logPath: join(home, 'Library', 'Logs', 'Stim', 'dev.stim.server.log'),
      workingDirectory: home,
      serve: null,
    };
    const unit = join(agents, 'dev.stim.server.plist');
    const text = renderPlist(unmanaged ? spec : { ...spec, stimd: shim });
    writeFileSync(
      unit,
      unmanaged ? text.replace(/\t<key>StimService<\/key>\n\t<dict>[\s\S]*?\n\t<\/dict>\n/, '') : text,
    );
    if (binary) getExecutor().runFile('plutil', ['-convert', 'binary1', unit], { timeoutMs: 10_000 });
    const launcher = withHost ? [host, 'run'] : [];
    const args = [...launcher, ...loaded(spec.node, spec.script, [shim, '--service', '--port', '7787'])];
    const real = getExecutor();
    setExecutor({
      runFileQuiet: (file: string, argv: string[], options: ExecOptions) => {
        if (file === 'plutil') return real.runFileQuiet(file, argv, options);
        if (file === 'launchctl' && argv[0] === 'print')
          return `\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n\targuments = {\n${args.map((arg) => `\t\t${arg}\n`).join('')}\t}\n`;
        if (file === 'ps') return `4242 1 ${args.join(' ')}\n4243 4242 stimd\n`;
        return null;
      },
    });
    const setup = await readServerSetup('2.0.0');
    labels = [...(setup?.services ?? []), ...(setup?.staleServices ?? [])].map((service) => service.label);
    return setup ? [...serverSetupFindings(setup), ...serverPermissionFindings(setup)] : [];
  };

  it('finds the default unit by its StimService marker and reports the definition launchd still runs', async () => {
    const findings = await readUnit(false, (node, script) => [node, script, 'serve', '--service', '--port', '7787']);
    const stale = findings.find((finding) => finding.code === 'server-service-stale');
    expect(stale?.detail).toMatch(/launchd still runs the definition it loaded before/i);
    expect(stale?.fix).toContain('stim service install --port 7787');
  });

  it('reports only the stale shim unit when an external Android SDK denies access without a server or socket', async () => {
    vi.stubEnv('ANDROID_HOME', '/Volumes/ExternalSSD/Android/sdk');
    const findings = await readUnit(false, (_node, _script, shimArgs) => [...shimArgs, '--old-option']);
    expect(findings.map((finding) => finding.code)).toEqual(['server-service-stale']);
  });

  it('finds a binary plist by its StimService marker', async () => {
    const findings = await readUnit(false, (node, script) => [node, script, 'serve', '--service', '--port', '7787'], {
      binary: true,
    });
    expect(findings.map((finding) => finding.code)).toContain('server-service-stale');
  });

  it('keeps an unmanaged stim-server agent in doctor without the reinstall remedy', async () => {
    const findings = await readUnit(false, (node) => [node, 'other.mjs'], { unmanaged: true });
    expect(labels).toEqual(['dev.stim.server']);
    expect(findings.map((finding) => finding.code)).not.toContain('server-service-stale');
  });

  it.each([
    ['the default unit', false],
    ['a unit under Stim Host', true],
  ])('reports nothing for %s that runs the shim', async (_case, withHost) => {
    expect(await readUnit(withHost, (_node, _script, shimArgs) => shimArgs)).toEqual([]);
  });
});
