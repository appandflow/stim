import { afterEach, expect, test, vi } from 'vitest';
import { readAccessTicket, readHostPermissions } from '../offload/access-ticket.ts';

afterEach(() => vi.unstubAllEnvs());

test.each(['short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`])(
  'a ticket the server would ignore is not sent or hashed: %s',
  (value) => {
    vi.stubEnv('STIM_ACCESS_TICKET', value);
    expect(readAccessTicket()).toBeUndefined();
  },
);

test('doctor reports host permissions only in the documented shape', () => {
  const host = { name: 'mini', screenRecording: true, accessibility: false };
  expect(readHostPermissions({ ...host, extra: 1 })).toEqual(host);
  expect(readHostPermissions({ ...host, accessibility: 'yes' })).toBeUndefined();
  expect(readHostPermissions('mini')).toBeUndefined();
  expect(readHostPermissions(null)).toBeUndefined();
});
