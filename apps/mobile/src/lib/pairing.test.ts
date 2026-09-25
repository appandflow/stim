import { manualPairing, parsePairingCode } from '@/lib/pairing';

const code = (fields: Record<string, unknown>) =>
  JSON.stringify({ v: 1, name: 'Mac', endpoint: 'wss://mac.tail1234.ts.net', pairingToken: 't0k', ...fields });

describe('parsePairingCode', () => {
  it('accepts the payload Stim Desktop encodes', () => {
    expect(parsePairingCode(code({}))).toEqual({
      ok: true,
      payload: { v: 1, name: 'Mac', endpoint: 'wss://mac.tail1234.ts.net', pairingToken: 't0k' },
    });
  });

  it('refuses plain ws:// to another host, which would send the token unencrypted', () => {
    expect(parsePairingCode(code({ endpoint: 'ws://192.168.1.4:7787' })).ok).toBe(false);
    expect(parsePairingCode(code({ endpoint: 'ws://127.0.0.1:7787' })).ok).toBe(true);
  });

  it('refuses other QR codes and newer payload versions', () => {
    expect(parsePairingCode('https://example.com').ok).toBe(false);
    expect(parsePairingCode(code({ pairingToken: '' })).ok).toBe(false);
    expect(parsePairingCode(code({ v: 2 }))).toEqual({
      ok: false,
      error: 'This pairing code needs a newer version of the app.',
    });
  });
});

describe('manualPairing', () => {
  it('trims what a person types', () => {
    expect(manualPairing(' wss://mac.tail1234.ts.net/ ', ' t0k ')).toEqual({
      ok: true,
      payload: { v: 1, name: '', endpoint: 'wss://mac.tail1234.ts.net', pairingToken: 't0k' },
    });
  });
});
