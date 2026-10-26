import type { ServiceSpec } from '../src/service-plist.ts';
import { editUnit, parseSystemctlShow, parseUnit, renderUnit } from '../src/service-unit.ts';

const SPEC: ServiceSpec = {
  label: 'dev.stim.server',
  host: null,
  node: '/home/me/.nvm/versions/node/v22.12.0/bin/node',
  script: '/home/me/my apps/100%/$HOME/stim-server.mjs',
  port: 7787,
  env: ['JAVA_HOME=/usr/lib/jvm/java 17', 'TOKEN=a"b\\c%d$e\nf'],
  pathPrepend: ['/opt/android sdk/platform-tools'],
  environment: { STIM_HOME: '/home/me/.stim', SHELL: '/bin/bash' },
  logPath: '/home/me/.local/state/stim/dev.stim.server.log',
  workingDirectory: '/home/me',
  serve: { port: 7443, created: true },
};

describe('systemd unit', () => {
  it('quotes ExecStart words the way systemd reads them: spaces kept, % and $ doubled', () => {
    const exec = renderUnit(SPEC)
      .split('\n')
      .find((line) => line.startsWith('ExecStart='));
    expect(exec).toBe(
      'ExecStart="/home/me/.nvm/versions/node/v22.12.0/bin/node" "/home/me/my apps/100%%/$$HOME/stim-server.mjs" "--port" "7787" "--env" "JAVA_HOME" "--env" "TOKEN" "--path-prepend" "/opt/android sdk/platform-tools"',
    );
    expect(renderUnit(SPEC)).toContain('Environment="TOKEN=a\\"b\\\\c%%d$e\\nf"');
  });

  it('reads back what it wrote, with the label, the env values and the X-Stim record', () => {
    expect(parseUnit(renderUnit(SPEC, '/old/stim-server.mjs'))).toEqual({
      label: 'dev.stim.server',
      host: null,
      node: SPEC.node,
      script: SPEC.script,
      port: 7787,
      env: SPEC.env,
      pathPrepend: SPEC.pathPrepend,
      stimHome: '/home/me/.stim',
      logPath: SPEC.logPath,
      managed: true,
      serve: { port: 7443, created: true },
      previousScript: '/old/stim-server.mjs',
      programArguments: [SPEC.node, SPEC.script, ...renderArgs()],
    });
  });

  it('does not take a unit another tool wrote for its own', () => {
    expect(parseUnit('[Service]\nExecStart=/usr/bin/node /srv/stim-server.mjs --port 7787\n')).toBeNull();
    const unmarked = renderUnit(SPEC).replace('Managed=true', '');
    expect(parseUnit(unmarked)?.managed).toBe(false);
  });

  it('switches the server script and records the previous one, keeping every other line', () => {
    const text = renderUnit(SPEC, '/older/stim-server.mjs');
    const installed = parseUnit(text);
    if (!installed) throw new Error('unit did not parse');
    const args = installed.programArguments.map((arg, index) => (index === 1 ? '/new/stim-server.mjs' : arg));
    const edited = editUnit(text, { programArguments: args, previousScript: SPEC.script });
    expect(parseUnit(edited)).toEqual({
      ...installed,
      script: '/new/stim-server.mjs',
      previousScript: SPEC.script,
      programArguments: args,
    });
    expect(edited.split('\n').filter((line) => line.startsWith('PreviousScript='))).toHaveLength(1);
    expect(edited.replace(/^(ExecStart|PreviousScript)=.*\n/gm, '')).toBe(
      text.replace(/^(ExecStart|PreviousScript)=.*\n/gm, ''),
    );
  });

  it('records a serve route on a unit that had none, and replaces one it had', () => {
    const none = renderUnit({ ...SPEC, serve: null });
    const routed = editUnit(none, { serve: { port: 7450, created: false } });
    expect(parseUnit(routed)?.serve).toEqual({ port: 7450, created: false });
    expect(parseUnit(editUnit(routed, { serve: { port: 7451, created: true } }))?.serve).toEqual({
      port: 7451,
      created: true,
    });
  });
});

function renderArgs(): string[] {
  return [
    '--port',
    '7787',
    '--env',
    'JAVA_HOME',
    '--env',
    'TOKEN',
    '--path-prepend',
    '/opt/android sdk/platform-tools',
  ];
}

describe('systemctl show', () => {
  const show = (fields: Record<string, string>) =>
    Object.entries({
      LoadState: 'loaded',
      ActiveState: 'active',
      SubState: 'running',
      MainPID: '4242',
      NRestarts: '0',
      ExecMainCode: '0',
      ExecMainStatus: '0',
      ...fields,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

  it('reads a running server', () => {
    expect(parseSystemctlShow(show({}))).toEqual({ state: 'active (running)', pid: 4242, runs: 1, lastExitCode: null });
  });

  it('reports a server waiting to restart as a job with no pid and its exit, so a failed switch is seen at once', () => {
    expect(
      parseSystemctlShow(
        show({
          ActiveState: 'activating',
          SubState: 'auto-restart',
          MainPID: '0',
          NRestarts: '2',
          ExecMainCode: '1',
          ExecMainStatus: '1',
        }),
      ),
    ).toEqual({ state: 'activating (auto-restart)', pid: null, runs: 3, lastExitCode: '1' });
    expect(parseSystemctlShow(show({ MainPID: '0', ExecMainCode: '2', ExecMainStatus: '9' }))?.lastExitCode).toBe(
      'signal 9',
    );
  });

  it('has no job for a unit that is missing, stopped or failed', () => {
    expect(parseSystemctlShow(show({ LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead' }))).toBeNull();
    expect(parseSystemctlShow(show({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0' }))).toBeNull();
    expect(parseSystemctlShow(show({ ActiveState: 'failed', SubState: 'failed', MainPID: '0' }))).toBeNull();
  });
});
