const loadRuntimeVersion = (devServerOrigin: string | undefined, argv: string[]) => {
  const savedOrigin = process.env.EXPO_DEV_SERVER_ORIGIN;
  const savedArgv = process.argv;
  if (devServerOrigin === undefined) delete process.env.EXPO_DEV_SERVER_ORIGIN;
  else process.env.EXPO_DEV_SERVER_ORIGIN = devServerOrigin;
  process.argv = ['node', ...argv];
  try {
    let runtimeVersion: unknown;
    jest.isolateModules(() => {
      runtimeVersion = jest.requireActual<{ default: { runtimeVersion: unknown } }>('../app.config').default
        .runtimeVersion;
    });
    return runtimeVersion;
  } finally {
    process.argv = savedArgv;
    if (savedOrigin === undefined) delete process.env.EXPO_DEV_SERVER_ORIGIN;
    else process.env.EXPO_DEV_SERVER_ORIGIN = savedOrigin;
  }
};

const resolve = ['expo-updates', 'runtimeversion:resolve', '--platform', 'ios'];
const origin = 'http://localhost:8081';

describe('app config runtimeVersion', () => {
  it('keeps the fingerprint policy that TestFlight builds and OTA updates match on', () => {
    expect(loadRuntimeVersion(undefined, resolve)).toEqual({ policy: 'fingerprint' });
  });

  it('keeps the fingerprint in a build that runs under the dev server environment, such as expo run:ios --configuration Release', () => {
    expect(loadRuntimeVersion(origin, ['expo', 'run:ios', '--configuration', 'Release'])).toEqual({
      policy: 'fingerprint',
    });
    expect(loadRuntimeVersion(origin, ['expo', 'export'])).toEqual({ policy: 'fingerprint' });
  });

  it('keeps the fingerprint when eas-cli resolves the runtime for eas update or eas build', () => {
    expect(loadRuntimeVersion(origin, [...resolve, '--workflow', 'managed'])).toEqual({ policy: 'fingerprint' });
  });

  it('is static for the dev server runtimeversion:resolve child so manifest requests do not recompute the fingerprint', () => {
    expect(loadRuntimeVersion(origin, resolve)).toBe('dev-server');
  });
});
