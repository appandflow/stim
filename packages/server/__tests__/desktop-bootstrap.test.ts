import { createHmac } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { DesktopBootstrap, readDesktopBootstrap } from '../src/desktop-bootstrap.ts';

const key = Buffer.alloc(32, 7).toString('base64url');
const sign = (message: string) =>
  createHmac('sha256', Buffer.from(key, 'base64url')).update(message).digest('base64url');

test('the public challenge proves the server but cannot authorize its client', () => {
  const bootstrap = new DesktopBootstrap(key);
  const first = bootstrap.challenge();
  const second = bootstrap.challenge();
  expect(first.proof).toBe(sign(`server:${first.nonce}`));
  expect(bootstrap.verify(first.nonce, sign(`client:${first.nonce}`))).toBe(true);
  expect(bootstrap.verify(first.nonce, first.proof)).toBe(false);
  expect(bootstrap.verify(second.nonce, sign(`client:${first.nonce}`))).toBe(false);
  expect(
    new DesktopBootstrap(Buffer.alloc(32, 8).toString('base64url')).verify(first.nonce, sign(`client:${first.nonce}`)),
  ).toBe(false);
  expect(JSON.stringify({ bootstrap, first, second })).not.toContain(key);
});

test.each([null, 7, {}, '', 'x'.repeat(42), 'x'.repeat(44), '+'.repeat(43)])(
  'refuses malformed client proof %j',
  (proof) => {
    const bootstrap = new DesktopBootstrap(key);
    expect(bootstrap.verify(bootstrap.challenge().nonce, proof)).toBe(false);
  },
);

test.each(['', '\n'])('reads a fragmented private input with suffix %j', async (suffix) => {
  const input = Readable.from([key.slice(0, 2), Buffer.from(key.slice(2, 25)), key.slice(25), suffix]);
  const bootstrap = await readDesktopBootstrap(input);
  const { nonce } = bootstrap.challenge();
  expect(bootstrap.verify(nonce, sign(`client:${nonce}`))).toBe(true);
  expect(input.destroyed).toBe(true);
});

test.each(['', 'short-secret', `${key}\n\n`, `${key}secret`, '+'.repeat(43)])(
  'refuses invalid or oversized input without exposing it',
  async (text) => {
    const input = Readable.from([text]);
    await expect(readDesktopBootstrap(input)).rejects.toThrow('Desktop bootstrap input is invalid or unavailable.');
    expect(input.destroyed).toBe(true);
  },
);

test('a stalled or failed private pipe is closed and its input error stays private', async () => {
  const stalled = new PassThrough();
  await expect(readDesktopBootstrap(stalled, 10)).rejects.toThrow('Desktop bootstrap input is invalid or unavailable.');
  expect(stalled.destroyed).toBe(true);
  const failed = new PassThrough();
  const result = readDesktopBootstrap(failed);
  failed.destroy(new Error(`private input ${key}`));
  await expect(result).rejects.toThrow('Desktop bootstrap input is invalid or unavailable.');
});
