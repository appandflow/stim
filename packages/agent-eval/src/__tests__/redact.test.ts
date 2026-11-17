import { expect, test } from 'vitest';
import { redact, secretValues } from '../redact.ts';

const login = JSON.stringify({
  tokens: { access_token: 'abcdefgh-1234-secret', refresh_token: 'refresh"quoted-9876' },
  n: 5,
});

test('every string value of the login is redacted, with its JSON-escaped form, and short values are left', () => {
  const secrets = secretValues(login);
  expect(secrets).toEqual(['abcdefgh-1234-secret', 'refresh"quoted-9876']);
  const out = redact('cat gave abcdefgh-1234-secret and refresh\\"quoted-9876 n=5', secrets);
  expect(out).not.toContain('abcdefgh');
  expect(out).not.toContain('quoted-9876');
  expect(out).toContain('n=5');
});

test('token shapes are redacted without a known value', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  expect(redact(`t=${jwt} k=sk-abcdefghijklmnopqrstuv end`, [])).toBe('t=[redacted] k=[redacted] end');
});

test('a login that is not JSON yields no values instead of throwing', () => {
  expect(secretValues('{"tokens": ')).toEqual([]);
});
