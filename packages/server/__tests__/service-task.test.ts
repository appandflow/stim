import type { ServiceSpec } from '../src/service-plist.ts';
import { netstatListeners } from '../src/service.ts';
import { editTask, parseTask, renderTask, renderTaskXml, windowsArgument } from '../src/service-task.ts';

const SPEC: ServiceSpec = {
  label: 'dev.stim.server',
  host: null,
  node: 'C:\\Program Files\\nodejs\\node.exe',
  script: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@stim-cli\\server\\dist\\stim-server.mjs',
  port: 7787,
  env: ['JAVA_HOME=C:\\Program Files\\Eclipse Adoptium\\jdk-17', 'TOKEN=a"b'],
  pathPrepend: ['C:\\Program Files\\nodejs'],
  environment: { STIM_HOME: 'C:\\Users\\me\\.stim' },
  logPath: 'C:\\Users\\me\\AppData\\Local\\Stim\\Logs\\dev.stim.server.log',
  workingDirectory: 'C:\\Users\\me',
  serve: { port: 7443, created: true },
};

describe('Windows service file', () => {
  it('reads back what it wrote, with the env values and the serve record', () => {
    expect(parseTask(renderTask(SPEC))).toEqual({
      label: 'dev.stim.server',
      host: null,
      node: SPEC.node,
      script: SPEC.script,
      port: 7787,
      env: SPEC.env,
      pathPrepend: SPEC.pathPrepend,
      stimHome: 'C:\\Users\\me\\.stim',
      logPath: SPEC.logPath,
      managed: true,
      serve: { port: 7443, created: true },
      previousScript: null,
      programArguments: expect.arrayContaining([SPEC.node, SPEC.script, '--port', '7787']),
    });
  });

  it('switches the server script and records the previous one, or replaces only the serve record', () => {
    const installed = parseTask(renderTask(SPEC));
    const switched = parseTask(
      editTask(renderTask(SPEC), {
        programArguments: [SPEC.node, 'C:\\new\\stim-server.mjs', ...(installed?.programArguments.slice(2) ?? [])],
        previousScript: SPEC.script,
      }),
    );
    expect(switched).toMatchObject({ script: 'C:\\new\\stim-server.mjs', previousScript: SPEC.script, port: 7787 });
    expect(switched?.env).toEqual(SPEC.env);
    expect(parseTask(editTask(renderTask(SPEC), { serve: { port: 8443, created: false } }))).toMatchObject({
      serve: { port: 8443, created: false },
      script: SPEC.script,
    });
  });

  it('is not a service install wrote unless it says so', () => {
    expect(parseTask(renderTask(SPEC).replace('"managed": true', '"managed": false'))?.managed).toBe(false);
    expect(parseTask('not json')).toBeNull();
  });
});

describe('Windows scheduled task', () => {
  it('quotes words the way the C runtime splits them', () => {
    expect(windowsArgument('C:\\Program Files\\x.mjs')).toBe('"C:\\Program Files\\x.mjs"');
    expect(windowsArgument('a"b')).toBe('"a\\"b"');
    expect(windowsArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"');
  });

  it('runs the supervisor at the user logon without elevation, with XML-escaped paths', () => {
    const xml = renderTaskXml({
      label: 'dev.stim.server',
      user: 'S-1-5-21-1-2-3-1001',
      node: 'C:\\R&D\\node.exe',
      runner: 'C:\\Users\\me\\AppData\\Local\\Stim\\services\\dev.stim.server\\stim-service-runner.mjs',
      file: 'C:\\Users\\me\\AppData\\Local\\Stim\\services\\dev.stim.server.json',
      state: 'C:\\Users\\me\\AppData\\Local\\Stim\\services\\dev.stim.server\\supervisor.json',
      workingDirectory: 'C:\\Users\\me',
    });
    expect(xml).toContain('<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-1-2-3-1001</UserId></LogonTrigger>');
    expect(xml).toContain('<LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<Priority>4</Priority>');
    expect(xml).toContain('<Command>C:\\R&#38;D\\node.exe</Command>');
    expect(xml).toMatch(
      /<Arguments>&#34;C:\\Users.*stim-service-runner\.mjs&#34; .*supervisor\.json&#34; &#34;30&#34;<\/Arguments>/,
    );
  });
});

test('netstat listeners are the pids listening on exactly that port, whatever the locale calls the state', () => {
  const output = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
    '  TCP    127.0.0.1:7787         0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:7787         127.0.0.1:50000        ESTABLISHED     4242',
    '  TCP    100.100.38.114:7787    0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:17787        0.0.0.0:0              LISTENING       99',
    '  TCP    [::]:7787              [::]:0                 ABH\u00d6REN         4243',
    '  UDP    0.0.0.0:7787           *:*                                    77',
  ].join('\r\n');
  expect(netstatListeners(output, 7787)).toEqual(['4242', '4243']);
});
