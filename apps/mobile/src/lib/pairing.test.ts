import vectors from '../../../desktop/Tests/StimKitTests/Fixtures/pairing-endpoint-vectors.json';
import { endpointHost, isExpectedHost, manualPairing, parsePairingCode } from '@/lib/pairing';

const TOKEN = 'TzVwCxX0F3_3bAXKpgOSMq7xNgGMdHUpcnWL3yIrj5w';
const FINGERPRINT = 'kM6qZt0yD3R8oN1vWlFc2sB9eHjXaQ4uYiPg7rTkLmE';
const code = (fields: Record<string, unknown>) =>
  JSON.stringify({
    v: 2,
    name: 'Mac',
    endpoint: 'wss://mac.tail1234.ts.net',
    pairingToken: TOKEN,
    fingerprint: FINGERPRINT,
    ...fields,
  });

describe('parsePairingCode', () => {
  it('reads the server key fingerprint and ignores fields it does not know', () => {
    expect(parsePairingCode(code({ endpoints: [{ transport: 'tailscale' }] }))).toEqual({
      ok: true,
      payload: {
        v: 2,
        name: 'Mac',
        endpoint: 'wss://mac.tail1234.ts.net',
        pairingToken: TOKEN,
        fingerprint: FINGERPRINT,
      },
    });
  });

  it('accepts the endpoints the shared vectors list for the phone app', () => {
    expect(vectors.endpoints.some((vector) => vector.kind === 'localNetwork')).toBe(true);
    for (const { endpoint, phone } of vectors.endpoints) {
      expect([endpoint, parsePairingCode(code({ endpoint })).ok]).toEqual([endpoint, phone]);
    }
  });

  it('refuses a code without a fingerprint, a malformed token, and other QR codes', () => {
    expect(parsePairingCode('https://example.com').ok).toBe(false);
    expect(parsePairingCode(code({ fingerprint: undefined })).ok).toBe(false);
    expect(parsePairingCode(code({ pairingToken: 't0k' })).ok).toBe(false);
  });

  it('tells an old stim-server apart from a newer payload', () => {
    expect(parsePairingCode(code({ v: 1 }))).toEqual({
      ok: false,
      error: 'This pairing code is from an older stim-server. Update stim-server on the machine that showed it.',
    });
    expect(parsePairingCode(code({ v: 3 }))).toEqual({
      ok: false,
      error: 'This pairing code needs a newer version of the app.',
    });
  });
});

describe('manualPairing', () => {
  it('trims what a person types and has no server key to check', () => {
    expect(manualPairing(' wss://mac.tail1234.ts.net/ ', ` ${TOKEN} `)).toEqual({
      ok: true,
      payload: { v: 2, name: '', endpoint: 'wss://mac.tail1234.ts.net', pairingToken: TOKEN },
    });
  });
});

describe('isExpectedHost', () => {
  it.each(['mac.tail1234.ts.net', 'localhost', '127.0.0.1', '[::1]', '192.168.1.4', '100.101.102.103'])(
    'accepts %s',
    (host) => {
      expect(isExpectedHost(endpointHost(`wss://${host}:7443`))).toBe(true);
    },
  );

  it.each(['evil.example.com', 'ts.net.evil.com', 'evilts.net', '8.8.8.8'])('flags %s', (host) => {
    expect(isExpectedHost(endpointHost(`wss://${host}`))).toBe(false);
  });

  it('lowercases the host it shows', () => {
    expect(endpointHost('wss://Mac.Tail1234.TS.net:7443/x')).toBe('mac.tail1234.ts.net');
  });
});
