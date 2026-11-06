import { createServer, type Server } from 'node:http';
import { legacyServerRefusal } from '../src/legacy-server-probe.ts';

const portOf = (listening: Server) => {
  const address = listening.address();
  return typeof address === 'object' && address ? address.port : 0;
};

let server: Server;
let port: number;
let health: unknown;

beforeAll(async () => {
  server = createServer((_request, response) => response.end(JSON.stringify(health)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = portOf(server);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test.skipIf(process.platform === 'win32')(
  'an older stim-server on the port keeps the net thread off and names its version and pid',
  async () => {
    health = { server: 'stim-server', version: '1.42.3' };
    expect(await legacyServerRefusal(port, '1.43.0')).toMatch(
      new RegExp(
        `^stim-server 1\\.42\\.3 \\(Stim Desktop bundle, pid ${process.pid}\\) holds port ${port}; update Stim Desktop \\(Stim > Check for Updates\\) or quit it\\. Phone, shares and remote builds for \\S+ wait until then\\.$`,
      ),
    );
    health = { server: 'stim-server', version: '1.43.0-next.4' };
    expect(await legacyServerRefusal(port, '1.43.0')).toContain('stim-server 1.43.0-next.4 (');
  },
);

test.each([
  ['the floor', { server: 'stim-server', version: '1.43.0' }, '1.43.0'],
  ['a newer version', { server: 'stim-server', version: '1.44.1' }, '1.43.0'],
  ['another program', { version: '1.0.0' }, '1.43.0'],
  ['an unpinned floor', { server: 'stim-server', version: '1.0.0' }, null],
])('%s on the port is not refused', async (_name, answer, floor) => {
  health = answer;
  expect(await legacyServerRefusal(port, floor)).toBeNull();
});

test('nothing on the port is not refused', async () => {
  const free = createServer();
  await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
  const unused = portOf(free);
  await new Promise<void>((resolve) => free.close(() => resolve()));
  expect(await legacyServerRefusal(unused, '1.43.0')).toBeNull();
});
