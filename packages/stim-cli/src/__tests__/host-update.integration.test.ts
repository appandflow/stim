import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHostApp } from '@stim-cli/server/cli';
import { keepHostCurrent } from '../stimd/host-update.ts';

const updating = vi.hoisted(() => {
  let entered: () => void = () => {};
  return { started: new Promise<void>((resolve) => (entered = resolve)), entered: () => entered() };
});

vi.mock('../server-cli.ts', async () => {
  const server = await import('@stim-cli/server/cli');
  return {
    loadServerCli: async () => ({
      ...server,
      updateInstalledHostApp: () => {
        const update = server.updateInstalledHostApp({ version: '9.9.9', sha256: '0'.repeat(64) });
        updating.entered();
        return update;
      },
    }),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: (
      file: string,
      args: string[],
      options: import('node:child_process').ExecFileOptionsWithStringEncoding,
      callback: (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => void,
    ) =>
      file === '/usr/bin/codesign' && args[0] === '--verify'
        ? callback(null, '', '')
        : original.execFile(file, args, options, callback),
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-host-update-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function installHost(version: string, applications: string): string {
  const app = join(applications, 'Stim Host.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<plist><dict><key>CFBundleIdentifier</key><string>dev.stim.host</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  const executable = join(app, 'Contents', 'MacOS', 'stim-host');
  writeFileSync(executable, version);
  return executable;
}

test.skipIf(process.platform !== 'darwin')(
  'stimd waits on the machine lock for a running Stim Host install and does not downgrade what it installed',
  async () => {
    const executable = installHost('0.1.1', join(home, 'Applications'));
    installHost('10.0.0', join(home, 'release'));
    const archive = join(home, 'StimHost.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(home, 'release', 'Stim Host.app'), archive]);
    const zip = readFileSync(archive);
    let deliver: (response: Response) => void = () => {};
    let downloading: () => void = () => {};
    const started = new Promise<void>((resolve) => (downloading = resolve));
    const download = vi.fn<(url: string) => Promise<Response>>(async (url) => {
      if (!url.includes('host-v10.0.0')) return new Response('missing', { status: 404 });
      downloading();
      return new Promise((resolve) => (deliver = resolve));
    });
    vi.stubGlobal('fetch', download);
    const explicit = installHostApp(undefined, {
      version: '10.0.0',
      sha256: createHash('sha256').update(zip).digest('hex'),
    });
    await started;
    const log = vi.fn<Parameters<typeof keepHostCurrent>[0]>();
    const automatic = keepHostCurrent(log);
    await updating.started;
    deliver(new Response(zip));
    await explicit;
    await automatic;
    expect(download).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(readFileSync(executable, 'utf8')).toBe('10.0.0');
  },
  30_000,
);
