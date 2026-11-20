import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPlist } from '@stim-cli/server/service-plist';
import { readServerSetup } from '../diagnostics/server-setup-probe.ts';
import { serverSetupFindings } from '../diagnostics/server-setup.ts';
import { getExecutor, resetExecutor, setExecutor, type ExecOptions } from '../exec.ts';

describe.skipIf(process.platform !== 'darwin')('doctor on a LaunchAgent that install wrote for the engine shim', () => {
  let home: string;
  afterEach(() => {
    resetExecutor();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  });

  /** Writes the default unit for the shim, optionally under Stim Host, and answers `launchctl print` with `loaded`. */
  const readUnit = async (
    withHost: boolean,
    loaded: (node: string, script: string, args: string[]) => string[],
    { binary = false, unmanaged = false, lastExit = '(never exited)' } = {},
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
          return `\tstate = running\n\tpid = 4242\n\truns = 2\n\tlast exit code = ${lastExit}\n\targuments = {\n${args.map((arg) => `\t\t${arg}\n`).join('')}\t}\n`;
        if (file === 'ps') return `4242 1 ${args.join(' ')}\n4243 4242 stimd\n`;
        return null;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (new URL(url).port !== '7787') throw new Error('connection refused');
        return new Response(
          JSON.stringify({
            server: 'stim-server',
            version: '2.0.0',
            stim: '2.0.0',
            stimHome: join(home, 'state'),
            startup: { state: 'ready' },
          }),
        );
      }),
    );
    const setup = await readServerSetup('2.0.0');
    expect(setup?.services.map((service) => service.label)).toEqual(['dev.stim.server']);
    return setup ? serverSetupFindings(setup) : [];
  };

  it('finds the default unit by its StimService marker and reports the definition launchd still runs', async () => {
    const findings = await readUnit(false, (node, script) => [node, script, 'serve', '--service', '--port', '7787']);
    const stale = findings.find((finding) => finding.code === 'server-service-stale');
    expect(stale?.detail).toMatch(/launchd still runs the definition it loaded before/i);
    expect(stale?.fix).toContain('stim service install --port 7787');
  });

  it('finds a binary plist by its StimService marker', async () => {
    const findings = await readUnit(false, (node, script) => [node, script, 'serve', '--service', '--port', '7787'], {
      binary: true,
    });
    expect(findings.map((finding) => finding.code)).toContain('server-service-stale');
  });

  it('keeps an unmanaged stim-server agent in doctor without the reinstall remedy', async () => {
    const findings = await readUnit(false, (node) => [node, 'other.mjs'], { unmanaged: true });
    expect(findings.map((finding) => finding.code)).not.toContain('server-service-stale');
  });

  it('reads the health of a running shim service, so an earlier nonzero exit is no crash finding', async () => {
    const findings = await readUnit(false, (_node, _script, shimArgs) => shimArgs, { lastExit: '1' });
    expect(findings.map((finding) => finding.code)).not.toContain('server-service-crash');
  });

  it.each([
    ['the default unit', false],
    ['a unit under Stim Host', true],
  ])('reports nothing for %s that runs the shim', async (_case, withHost) => {
    expect(await readUnit(withHost, (_node, _script, shimArgs) => shimArgs)).toEqual([]);
  });
});
