import { declaredServicesFrom, startOrder, substitute } from '../services.ts';

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
