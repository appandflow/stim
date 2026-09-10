import { expect, it } from 'vitest';
import { javascriptProof, appAliveErrorIsSuperseded } from './javascript-proof.mjs';

const expected = 'Keep saved trail maps available offline';
const screen = { valid: true, expected, target: '/proof/settings.png' };

it('requires both the requested source edit and validated changed Settings screen', () => {
  expect(javascriptProof(expected, '/settings.tsx', screen)).toMatchObject({
    valid: true,
    kind: 'source-edit-and-settings-screen',
  });
  expect(javascriptProof('old text', '/settings.tsx', screen)).toMatchObject({
    valid: false,
    reason: 'source-edit-missing',
  });
  expect(javascriptProof(null, null, screen).valid).toBe(false);
  expect(javascriptProof(expected, '/settings.tsx', { ...screen, valid: false }).valid).toBe(false);
  expect(javascriptProof(expected, '/settings.tsx', { ...screen, expected: 'old text' }).valid).toBe(false);
});

it('supersedes only a legacy bundle timeout with live-device and changed-screen proof', () => {
  const alive = {
    error: 'proof-timeout-after-app-alive',
    observedAt: '2026-09-10T22:50:00Z',
    simulator: { udid: 'owned-device' },
  };
  const proof = javascriptProof(expected, '/settings.tsx', screen);
  expect(appAliveErrorIsSuperseded(alive, proof, screen)).toBe(true);
  for (const change of [{ error: 'wrong-device' }, { observedAt: null }, { simulator: {} }]) {
    expect(appAliveErrorIsSuperseded({ ...alive, ...change }, proof, screen)).toBe(false);
  }
  expect(appAliveErrorIsSuperseded(alive, { valid: false }, screen)).toBe(false);
  expect(appAliveErrorIsSuperseded(alive, proof, { valid: false })).toBe(false);
});
