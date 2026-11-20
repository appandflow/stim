import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answered } from '../workspace/bounded-read.ts';
import { checkoutOwnerOf } from '../workspace/checkout-role.ts';

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-checkout-role-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test('a registered app inside a monorepo is owned by the folder holding .git, and a folder in no checkout by itself', async () => {
  const mono = join(base, 'mono');
  mkdirSync(join(mono, 'apps', 'native'), { recursive: true });
  mkdirSync(join(mono, '.git'));
  mkdirSync(join(base, 'loose'));

  expect((await checkoutOwnerOf(join(mono, 'apps', 'native'))).checkout).toBe(mono);
  expect((await checkoutOwnerOf(join(base, 'loose'))).checkout).toBe(join(base, 'loose'));
});

test('the owner is unknown, which keeps the checkout, while an earlier read is still pending, and found once it settles', async () => {
  const mono = join(base, 'mono');
  mkdirSync(join(mono, 'apps'), { recursive: true });
  mkdirSync(join(mono, '.git'));
  let release: (value: string) => void = () => {};
  const stuck = answered('/stalled-mount', () => new Promise<string>((resolve) => (release = resolve)), 10).catch(
    () => 'timed out',
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(await stuck).toBe('timed out');

  expect((await checkoutOwnerOf(join(mono, 'apps'))).checkout).toMatchObject({
    unknown: expect.stringContaining('/stalled-mount'),
  });

  release('late');
  await vi.advanceTimersByTimeAsync(0);
  expect((await checkoutOwnerOf(join(mono, 'apps'))).checkout).toBe(mono);
});
