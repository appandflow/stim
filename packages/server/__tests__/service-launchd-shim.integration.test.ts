import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { rewriteUnitToShim } from '../src/service.ts';
import { renderPlist, type ServiceSpec } from '../src/service-plist.ts';

describe.skipIf(process.platform !== 'darwin')('LaunchAgent pinned to a server script', { timeout: 30_000 }, () => {
  const label = 'dev.stim.shim-reload';
  let home: string;
  let plist: string;
  let shim: string;
  let spec: ServiceSpec;
  let job: ChildProcess;

  const json = (path: string) =>
    JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));
  const read = (name: string) => (existsSync(join(home, name)) ? readFileSync(join(home, name), 'utf8') : '');
  const loadedArguments = () => json(join(home, 'loaded.plist')).ProgramArguments;
  const startJob = () => {
    job = spawn('sleep', ['60'], { stdio: 'ignore' });
    writeFileSync(join(home, 'pid'), String(job.pid));
  };
  const endJob = () => new Promise((exited) => job.once('exit', exited).kill());

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-launchd-shim-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    // Stands in for launchd: `print` shows the plist it read at the last `bootstrap`, `bootout` forgets it.
    writeFileSync(
      join(bin, 'launchctl'),
      `#!${process.execPath}
const { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const home = ${JSON.stringify(home)};
const loaded = home + '/loaded.plist';
const [command, , path] = process.argv.slice(2);
if (command !== 'print') appendFileSync(home + '/calls', command + '\\n');
if (command === 'print') {
  if (!existsSync(loaded)) { console.error('Could not find service'); process.exit(113); }
  const args = JSON.parse(execFileSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', loaded], { encoding: 'utf8' }));
  const pid = readFileSync(home + '/pid', 'utf8');
  console.log('\\tstate = running\\n\\tpid = ' + pid + '\\n\\targuments = {\\n' + args.map((arg) => '\\t\\t' + arg + '\\n').join('') + '\\t}');
} else if (command === 'bootout') {
  if (existsSync(home + '/fail-bootout')) { console.error('Boot-out failed: 5: Input/output error'); process.exit(5); }
  rmSync(loaded, { force: true });
} else if (command === 'bootstrap') {
  copyFileSync(path, loaded);
}
`,
    );
    chmodSync(join(bin, 'launchctl'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', home);
    vi.stubEnv('STIM_ENGINE_ROOT', join(home, 'engine'));
    shim = join(home, 'engine', 'bin', 'stimd');
    mkdirSync(join(home, 'engine', 'bin'), { recursive: true });
    writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
    spec = {
      label,
      host: '/Applications/Stim Host.app/Contents/MacOS/stim-host',
      node: '/usr/local/bin/node',
      script: '/old/stim/bin/stim.mjs',
      port: 7787,
      env: ['ANDROID_HOME=/sdk'],
      pathPrepend: ['/jdk/bin'],
      environment: { STIM_HOME: join(home, '.stim'), SHELL: '/bin/zsh' },
      logPath: join(home, 'server.log'),
      workingDirectory: home,
      serve: { port: 7449, created: true },
    };
    plist = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, renderPlist(spec).replace('<string>Standard</string>', '<string>Background</string>'));
    writeFileSync(join(home, 'loaded.plist'), readFileSync(plist));
    startJob();
  });

  afterEach(() => {
    job.kill();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('renders the plist for the shim and loads it again once the job has exited', async () => {
    expect(await rewriteUnitToShim(label)).toBe(true);
    const expected = join(home, 'expected.plist');
    writeFileSync(expected, renderPlist({ ...spec, stimd: shim }));
    expect(json(plist)).toEqual(json(expected));
    await new Promise((settle) => setTimeout(settle, 500));
    expect(read('calls')).toBe('');

    await endJob();
    await vi.waitFor(
      () => expect(read('server.log')).toContain(`stim: ${label} now runs the engine shim from its rewritten plist.`),
      {
        timeout: 15_000,
      },
    );
    expect(read('calls')).toBe('bootout\nbootstrap\n');
    expect(loadedArguments()).toEqual([
      spec.host,
      'run',
      shim,
      '--service',
      '--port',
      '7787',
      '--env',
      'ANDROID_HOME',
      '--path-prepend',
      '/jdk/bin',
    ]);

    startJob();
    expect(await rewriteUnitToShim(label)).toBe(false);
  });

  it('asks for no restart when launchd already runs the plist renderPlist writes for the shim', async () => {
    writeFileSync(plist, renderPlist({ ...spec, stimd: shim }));
    writeFileSync(join(home, 'loaded.plist'), readFileSync(plist));
    const before = readFileSync(plist, 'utf8');
    expect(await rewriteUnitToShim(label)).toBe(false);
    expect(readFileSync(plist, 'utf8')).toBe(before);
  });

  it('renders and loads again a shim plist with keys an earlier release wrote', async () => {
    writeFileSync(
      plist,
      renderPlist({ ...spec, stimd: shim }).replace(/(<key>ProcessType<\/key>\s*<string>)[^<]*/, '$1Background'),
    );
    writeFileSync(join(home, 'loaded.plist'), readFileSync(plist));
    expect(await rewriteUnitToShim(label)).toBe(true);
    expect(readFileSync(plist, 'utf8')).toBe(renderPlist({ ...spec, stimd: shim }));
    await endJob();
    await vi.waitFor(() => expect(read('calls')).toBe('bootout\nbootstrap\n'), { timeout: 15_000 });
    expect(json(join(home, 'loaded.plist')).ProcessType).toBe(json(plist).ProcessType);
  });

  it('loads the job again when only the plist names the shim', async () => {
    writeFileSync(plist, renderPlist({ ...spec, stimd: shim }));
    const before = readFileSync(plist, 'utf8');
    expect(await rewriteUnitToShim(label)).toBe(true);
    expect(readFileSync(plist, 'utf8')).toBe(before);
    await endJob();
    await vi.waitFor(() => expect(read('calls')).toBe('bootout\nbootstrap\n'), { timeout: 15_000 });
    expect(loadedArguments()).toContain(shim);
  });

  it.each([
    ['unloaded', () => rmSync(join(home, 'loaded.plist'))],
    ['installed again', () => writeFileSync(plist, renderPlist({ ...spec, stimd: shim, port: 7788 }))],
  ])('leaves a job that was %s meanwhile alone', async (_case, meanwhile) => {
    expect(await rewriteUnitToShim(label)).toBe(true);
    meanwhile();
    await endJob();
    await new Promise((settle) => setTimeout(settle, 1500));
    expect(read('calls')).toBe('');
  });

  it('throws with the remedy instead of asking for another restart after a reload that did not take', async () => {
    writeFileSync(join(home, 'fail-bootout'), '');
    expect(await rewriteUnitToShim(label)).toBe(true);
    await endJob();
    await vi.waitFor(
      () =>
        expect(read('server.log')).toMatch(/could not unload .* `launchctl bootout gui\/\d+\/dev\.stim\.shim-reload/),
      {
        timeout: 15_000,
      },
    );
    startJob();
    await expect(rewriteUnitToShim(label)).rejects.toThrow(
      /still runs dev\.stim\.shim-reload .* run `launchctl bootout gui\/\d+\/dev\.stim\.shim-reload` and `launchctl bootstrap/,
    );
    expect(read('calls')).toBe('bootout\n');
  });
});
