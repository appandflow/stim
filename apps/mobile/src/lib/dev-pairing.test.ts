import { devPairing } from '@/lib/dev-pairing';

const setDev = (value: boolean) => Object.assign(globalThis, { __DEV__: value });

describe('devPairing', () => {
  const dev = __DEV__;
  const code = {
    v: 2,
    name: 'Mock',
    endpoint: 'ws://127.0.0.1:7787',
    pairingToken: 'TzVwCxX0F3_3bAXKpgOSMq7xNgGMdHUpcnWL3yIrj5w',
    fingerprint: 'kM6qZt0yD3R8oN1vWlFc2sB9eHjXaQ4uYiPg7rTkLmE',
  };
  beforeEach(() => {
    process.env.EXPO_PUBLIC_STIM_DEV_PAIRING = JSON.stringify(code);
  });
  afterEach(() => {
    setDev(dev);
    delete process.env.EXPO_PUBLIC_STIM_DEV_PAIRING;
  });

  it('pairs from .env.local in development', () => {
    setDev(true);
    expect(devPairing()).toEqual(code);
  });

  it('ignores .env.local in release builds, which Expo also loads it for', () => {
    setDev(false);
    expect(devPairing()).toBeNull();
  });
});
