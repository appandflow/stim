import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInstalledPlist, renderPlist, staleLaunchAgent, type ServiceSpec } from '../src/service-plist.ts';

describe.skipIf(process.platform !== 'darwin')('a LaunchAgent that launchd runs from a stale definition', () => {
  const shim = '/Users/me/.stim/engine/bin/stimd';
  const host = '/Applications/Stim Host.app/Contents/MacOS/stim-host';
  const spec: ServiceSpec = {
    label: 'dev.stim.server',
    host,
    node: '/usr/local/bin/node',
    script: '/Users/me/.npm/lib/node_modules/stim/bin/stim.mjs',
    port: 7787,
    env: ['ANDROID_HOME=/sdk'],
    pathPrepend: ['/jdk/bin'],
    environment: { STIM_HOME: '/Users/me/.stim' },
    logPath: '/Users/me/Library/Logs/Stim/dev.stim.server.log',
    workingDirectory: '/Users/me',
    serve: null,
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-service-stale-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const installed = (text: string) => {
    writeFileSync(join(dir, 'unit.plist'), text);
    const parsed = parseInstalledPlist(
      JSON.parse(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', join(dir, 'unit.plist')], { encoding: 'utf8' }),
      ),
    );
    if (!parsed) throw new Error('unreadable plist');
    return parsed;
  };
  const shimPlist = renderPlist({ ...spec, stimd: shim });
  const shimArgs = [
    host,
    'run',
    shim,
    '--service',
    '--port',
    '7787',
    '--env',
    'ANDROID_HOME',
    '--path-prepend',
    '/jdk/bin',
  ];
  const nodeArgs = [
    host,
    'run',
    spec.node,
    spec.script,
    'serve',
    '--service',
    '--port',
    '7787',
    '--env',
    'ANDROID_HOME',
    '--path-prepend',
    '/jdk/bin',
  ];

  it.each([
    ['a current shim unit', shimPlist, shimArgs, shim, null],
    ['a node unit without an engine store', renderPlist(spec), nodeArgs, null, null],
    ['a node unit that launchd has not loaded', renderPlist(spec), null, null, null],
    [
      'a shim plist launchd loaded before the rewrite',
      shimPlist,
      nodeArgs,
      shim,
      /launchd still runs the definition it loaded before/,
    ],
    [
      'a node plist while the engine store exists',
      renderPlist(spec),
      nodeArgs,
      shim,
      /does not start the engine's stimd shim/,
    ],
    [
      'a plist with the ProcessType an earlier release wrote',
      shimPlist.replace(/(<key>ProcessType<\/key>\s*<string>)[^<]*/, '$1Background'),
      shimArgs,
      shim,
      /sets ProcessType Background, and `stim service install` writes /,
    ],
    ['a shim plist after the engine was uninstalled', shimPlist, shimArgs, null, /no bin\/stimd shim/],
    ['a Stim Host plist whose loaded job skips the host', shimPlist, shimArgs.slice(2), shim, /other than its plist/],
  ])('%s', (_case, text, loaded, engineShim, stale) => {
    expect(staleLaunchAgent(installed(text), loaded, engineShim) ?? '').toMatch(stale ?? /^$/);
  });

  it('reads the top-level ProcessType, not an --env value of that name, and never prints the value', () => {
    const withEnv = { ...spec, stimd: shim, env: [...spec.env, 'ProcessType=private-value'] };
    const current = installed(renderPlist(withEnv));
    const args = current.programArguments;
    expect(args).toContain('ProcessType');
    expect(staleLaunchAgent(current, args, shim)).toBeNull();
    const old = renderPlist(withEnv).replace(/(\n\t<key>ProcessType<\/key>\n\t<string>)[^<]*/, '$1Background');
    const reason = staleLaunchAgent(installed(old), args, shim);
    expect(reason).toMatch(/ProcessType Background/);
    expect(reason).not.toContain('private-value');
  });
});
