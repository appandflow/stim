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
    rmSync(home, { recursive: true, force: true });
  });

  it('finds the default unit by its StimService marker and reports the definition launchd still runs', async () => {
    home = mkdtempSync(join(tmpdir(), 'stim-probe-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('STIM_HOME', join(home, 'state'));
    vi.stubEnv('STIM_ENGINE_ROOT', join(home, 'engine'));
    const shim = join(home, 'engine', 'bin', 'stimd');
    mkdirSync(join(home, 'engine', 'bin'), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
    const agents = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    const spec = {
      label: 'dev.stim.server',
      host: null,
      node: '/usr/local/bin/node',
      script: '/usr/local/lib/node_modules/stim/bin/stim.mjs',
      port: 7787,
      env: [],
      pathPrepend: [],
      environment: { STIM_HOME: join(home, 'state') },
      logPath: join(home, 'Library', 'Logs', 'Stim', 'dev.stim.server.log'),
      workingDirectory: home,
      serve: null,
    };
    writeFileSync(join(agents, 'dev.stim.server.plist'), renderPlist({ ...spec, stimd: shim }));
    const loaded = [spec.node, spec.script, 'serve', '--service', '--port', '7787'];
    const real = getExecutor();
    setExecutor({
      runFileQuiet: (file: string, args: string[], options: ExecOptions) => {
        if (file === 'plutil') return real.runFileQuiet(file, args, options);
        if (file === 'launchctl' && args[0] === 'print')
          return `\tstate = running\n\tpid = 4242\n\targuments = {\n${loaded.map((arg) => `\t\t${arg}\n`).join('')}\t}\n`;
        return null;
      },
    });
    const setup = await readServerSetup('2.0.0');
    expect(setup?.services.map((service) => service.label)).toEqual(['dev.stim.server']);
    const stale = (setup ? serverSetupFindings(setup) : []).find((finding) => finding.code === 'server-service-stale');
    expect(stale?.detail).toMatch(/launchd still runs the definition it loaded before/i);
    expect(stale?.fix).toContain('stim service install --port 7787');
  });
});
