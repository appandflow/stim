import type { ServiceSpec } from '../src/service-plist.ts';
import { netstatListeners } from '../src/service.ts';
import { editTask, parseTask, renderTask, renderTaskXml } from '../src/service-task.ts';

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
});

describe('Windows scheduled task', () => {
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
