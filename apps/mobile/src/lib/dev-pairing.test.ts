import { devPairing } from '@/lib/dev-pairing';

const setDev = (value: boolean) => Object.assign(globalThis, { __DEV__: value });

describe('devPairing', () => {
  const dev = __DEV__;
  beforeEach(() => {
    process.env.EXPO_PUBLIC_STIM_DEV_ENDPOINT = 'ws://127.0.0.1:7787';
    process.env.EXPO_PUBLIC_STIM_DEV_DEVICE_TOKEN = 'd';
  });
  afterEach(() => {
    setDev(dev);
    delete process.env.EXPO_PUBLIC_STIM_DEV_ENDPOINT;
    delete process.env.EXPO_PUBLIC_STIM_DEV_DEVICE_TOKEN;
  });

  it('pairs from .env.local in development', () => {
    setDev(true);
    expect(devPairing()).toEqual({ endpoint: 'ws://127.0.0.1:7787', deviceToken: 'd' });
  });

  it('ignores .env.local in release builds, which Expo also loads it for', () => {
    setDev(false);
    expect(devPairing()).toBeNull();
  });
});
