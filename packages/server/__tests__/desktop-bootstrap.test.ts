import { PassThrough } from 'node:stream';
import { readDesktopBootstrap } from '../src/desktop-bootstrap.ts';

const key = Buffer.alloc(32, 7).toString('base64url');

test.each(['end', 'error', 'close', 'extra'] as const)(
  'parent %s immediately after the key is retained until shutdown',
  async (event) => {
    const input = new PassThrough();
    const reading = readDesktopBootstrap(input);
    input.write(`${key}\n`);
    if (event === 'end') input.end();
    if (event === 'error') input.destroy(new Error('lost parent'));
    if (event === 'close') input.destroy();
    if (event === 'extra') input.write('unexpected');
    const { closed } = await reading;
    await closed;
    expect(input.destroyed).toBe(true);
  },
);
