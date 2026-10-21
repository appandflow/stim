const loadRuntimeVersion = (devServerOrigin: string | undefined) => {
  const saved = process.env.EXPO_DEV_SERVER_ORIGIN;
  if (devServerOrigin === undefined) delete process.env.EXPO_DEV_SERVER_ORIGIN;
  else process.env.EXPO_DEV_SERVER_ORIGIN = devServerOrigin;
  try {
    let runtimeVersion: unknown;
    jest.isolateModules(() => {
      runtimeVersion = jest.requireActual<{ default: { runtimeVersion: unknown } }>('../app.config').default
        .runtimeVersion;
    });
    return runtimeVersion;
  } finally {
    if (saved === undefined) delete process.env.EXPO_DEV_SERVER_ORIGIN;
    else process.env.EXPO_DEV_SERVER_ORIGIN = saved;
  }
};

describe('app config runtimeVersion', () => {
  it('keeps the fingerprint policy that TestFlight builds and OTA updates match on', () => {
    expect(loadRuntimeVersion(undefined)).toEqual({ policy: 'fingerprint' });
  });

  it('is static for the Expo dev server so manifest requests do not recompute the fingerprint', () => {
    expect(loadRuntimeVersion('http://localhost:8081')).toBe('dev-server');
  });
});
