const mockInit = jest.fn();
const mockSetTags = jest.fn();

jest.mock('@sentry/react-native', () => ({ init: mockInit, setTags: mockSetTags }));
jest.mock('expo-updates', () => ({ updateId: null, channel: null, runtimeVersion: null }));

function load(dsn: string | undefined) {
  jest.resetModules();
  mockInit.mockClear();
  mockSetTags.mockClear();
  if (dsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  else process.env.EXPO_PUBLIC_SENTRY_DSN = dsn;
  jest.requireActual('./sentry');
}

describe('Sentry start', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  });

  it('sends nothing, and starts nothing, without a DSN', () => {
    load(undefined);
    expect(mockInit).not.toHaveBeenCalled();
    load('');
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('starts with the DSN, no personal data and the scrubbers', () => {
    load('https://key@o1.ingest.sentry.io/2');
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0][0]).toMatchObject({
      dsn: 'https://key@o1.ingest.sentry.io/2',
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableNetworkBreadcrumbs: false,
      enableAutoSessionTracking: false,
      beforeSend: expect.any(Function),
      beforeBreadcrumb: expect.any(Function),
    });
  });
});
