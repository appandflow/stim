import { afterEach, expect, test, vi } from 'vitest';
import { withAmbientContext } from '@stim-cli/core';
import { readAccessTicket, readHostPermissions } from '../offload/access-ticket.ts';
import { testContext } from './_context.ts';

afterEach(() => vi.unstubAllEnvs());

test.each(['short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`])(
  'a ticket that is not 32 base64url bytes is not used: %s',
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

test("an operation sends its own client's ticket, not the host process's", () => {
  vi.stubEnv('STIM_ACCESS_TICKET', 'h'.repeat(43));
  const context = testContext({ env: { ...process.env, STIM_ACCESS_TICKET: 'c'.repeat(43) } });
  expect(withAmbientContext(context, () => readAccessTicket())).toBe('c'.repeat(43));
});
