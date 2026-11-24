import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli/define-op.ts';
import servicesOp from '../commands/services.ts';
import { resetExecutor, setExecutor, type Executor } from '../exec.ts';
import {
  declaredServicesFrom,
  serviceId,
  serviceRecords,
  startOrder,
  startServices,
  substitute,
  teardownServices,
} from '../services.ts';
import { updateWorkspaceState } from '../workspace/workspace-state.ts';

test('plain services output shows a failed teardown and its recovery command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-services-output-'));
  const previousHome = process.env.STIM_HOME;
  const previousCwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.env.STIM_HOME = join(home, 'stim');
    process.chdir(home);
    const root = process.cwd();
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ services: { db: { start: 'db up', stop: 'db stop' } } }));
    const failure = `teardown command exited with status 1; run by hand in ${root}: db destroy`;
    updateWorkspaceState(root, (state) => ({
      ...state,
      services: {
        db: {
          kind: 'commands',
          cwd: root,
          env: {},
          dependsOn: [],
          ports: {},
          reverse: [],
          start: ['db', 'up'],
          stop: ['db', 'stop'],
          state: 'stopped',
          at: new Date().toISOString(),
          teardownFailure: failure,
        },
      },
    }));
    await runCli(servicesOp, [], { version: '0.0.0' });
    expect(log).toHaveBeenCalledWith(`db  stopped; teardown failed: ${failure}`);
  } finally {
    log.mockRestore();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

const values = { web: '8900', api: '8901', id: 'web-0123456789abcdef', dir: '/w/app', 'db.pg': '8902' };

test.each<[string, string, string]>([
  ['a port', 'python -m http.server {web}', 'python -m http.server 8900'],
  ['several ports in one value', 'http://127.0.0.1:{api}/x?web={web}', 'http://127.0.0.1:8901/x?web=8900'],
  ["another service's port", 'postgres://127.0.0.1:{db.pg}/app', 'postgres://127.0.0.1:8902/app'],
  ['the workspace id and the working directory', '{id}:{dir}', 'web-0123456789abcdef:/w/app'],
  ['doubled braces as literal braces', '{{"port": {web}}}', '{"port": 8900}'],
])('substitute replaces %s', (_name, text, expected) => {
  expect(substitute(text, values, 'services.web.start')).toBe(expected);
});

test.each<[string, string, RegExp]>([
  ['an unknown name', '{nope}', /names \{nope\}, which is not one of its ports/],
  ['an unmatched open brace', 'x{web', /unmatched \{/],
  ['an unmatched close brace', 'x}', /unmatched \}/],
])('substitute refuses %s', (_name, text, error) => {
  expect(() => substitute(text, values, 'services.web.start')).toThrow(error);
});

test('a one-line service is a supervised process: its string command splits on spaces and its placeholder is checked', () => {
  const [web] = declaredServicesFrom({ services: { web: { ports: ['web'], start: 'python -m http.server {web}' } } });
  expect(web).toMatchObject({ name: 'web', ports: { web: null }, start: ['python', '-m', 'http.server', '{web}'] });
  expect(web?.stop).toBeUndefined();
});

test.each<[string, Record<string, unknown>, RegExp]>([
  ['a placeholder that names no port', { web: { start: ['serve', '-l', '{web}'] } }, /names \{web\}/],
  ['shell syntax in a string command', { web: { start: 'serve -l $PORT' } }, /argv array/],
  ['a teardown without a stop command', { web: { start: 'serve', teardown: 'rm -rf data' } }, /without a stop command/],
  ['the managed Metro label', { web: { ports: ['metro'], start: 'serve' } }, /exclude metro/],
  ['a port two services own', { a: { ports: ['p'], start: 'a' }, b: { ports: ['p'], start: 'b' } }, /a also owns/],
  ['a dependency on an unknown service', { a: { start: 'a', dependsOn: ['b'] } }, /not another declared service/],
  [
    'a dependency cycle through references',
    { a: { ports: ['pa'], start: ['a', '{b.pb}'] }, b: { ports: ['pb'], start: ['b', '{a.pa}'] } },
    /depends on itself through a -> b -> a/,
  ],
])('the services setting refuses %s', (_name, services, error) => {
  expect(() => declaredServicesFrom({ services })).toThrow(error);
});

test('a service that names another service starts after it, and selecting one includes what it depends on', () => {
  const definitions = declaredServicesFrom({
    services: {
      webhooks: { start: ['listen', '--forward-to', 'localhost:{api.http}/hook'] },
      api: { ports: ['http'], start: ['api', '--port', '{http}'], dependsOn: ['db'] },
      db: { ports: { pg: 'PG_PORT' }, start: 'db up', stop: 'db stop' },
    },
  });
  const order = (selected: string[]) =>
    startOrder(
      definitions,
      definitions.filter((each) => selected.includes(each.name)),
    ).map((each) => each.name);
  expect(order(['webhooks', 'api', 'db'])).toEqual(['db', 'api', 'webhooks']);
  expect(order(['webhooks'])).toEqual(['db', 'api', 'webhooks']);
});

describe('teardown after the workspace folder is gone', () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-services-')));
    root = join(home, 'app');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{}');
    process.env.STIM_HOME = join(home, 'stim');
  });

  afterEach(() => {
    resetExecutor();
    rmSync(home, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test.each([
    { name: 'reuses teardown naming {id}', teardown: 'db down --id {id}', expected: ['down', '--id'] },
    { name: 'skips teardown without {id}', teardown: 'db down', expected: null },
    {
      name: 'prefers an explicit orphanTeardown',
      teardown: 'db down --id {id}',
      orphanTeardown: 'db orphan --id {id}',
      expected: ['orphan', '--id'],
    },
    { name: 'skips teardown with literal {{id}}', teardown: 'db down --id {{id}}', expected: null },
  ])('$name', async ({ teardown, orphanTeardown, expected }) => {
    writeFileSync(
      join(root, '.stim.json'),
      JSON.stringify({ services: { db: { start: 'db up', stop: 'db stop', teardown, orphanTeardown } } }),
    );
    const runFile = vi.fn<Executor['runFile']>(() => '');
    setExecutor({ runFile, runFileQuiet: () => '', findExecutable: (file) => (file === 'db' ? file : null) });
    expect(await startServices(root, 'db')).toMatchObject([{ outcome: 'started' }]);
    runFile.mockClear();
    rmSync(root, { recursive: true });

    const outcomes = await teardownServices(root);
    const notTornDown = expect.stringContaining('not torn down: no orphanTeardown');
    const fromHome = expect.objectContaining({ cwd: homedir() });
    const detail = expected ? 'torn down' : notTornDown;
    const calls = expected ? [['db', [...expected, serviceId(root, 'db')], fromHome]] : [];
    expect(outcomes).toEqual([{ name: 'db', outcome: 'torn-down', detail }]);
    expect(runFile.mock.calls).toEqual(calls);
    expect(serviceRecords(root)).toEqual({});
  });
});
