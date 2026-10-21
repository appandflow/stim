import type { ExpoConfig } from 'expo/config';

const variant = process.env.APP_VARIANT ?? 'production';
if (variant !== 'production' && variant !== 'development') {
  throw new Error(`APP_VARIANT must be production or development, not ${variant}.`);
}
const dev = variant === 'development';
const id = dev ? 'com.appandflow.stim.dev' : 'com.appandflow.stim';

const config: ExpoConfig = {
  name: dev ? 'Stim Dev' : 'Stim',
  slug: 'stim-mobile',
  version: '1.0.0',
  orientation: 'default',
  icon: dev ? './assets/images/icon-dev.png' : './assets/images/icon.png',
  scheme: dev ? ['stim', 'stim-dev'] : 'stim',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: id,
    icon: dev ? './assets/images/icon-ios-dev.png' : './assets/images/icon-ios.png',
    supportsTablet: true,
    config: {
      usesNonExemptEncryption: false,
    },
    infoPlist: {
      RCTUseAssetCatalog: true,
    },
    appleTeamId: 'R7E8P23K3N',
    associatedDomains: ['applinks:stim.appandflow.com'],
  },
  android: {
    package: id,
    adaptiveIcon: {
      backgroundColor: '#FFFFFF',
      foregroundImage: dev ? './assets/images/icon-dev.png' : './assets/images/icon.png',
    },
    predictiveBackGestureEnabled: false,
    permissions: ['android.permission.CAMERA'],
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#5521FF',
        image: './assets/images/splash-logo.png',
        imageWidth: 120,
        dark: {
          backgroundColor: '#5521FF',
          image: './assets/images/splash-logo.png',
        },
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission: 'Stim uses the camera to scan the pairing QR code that Stim Desktop shows.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    'expo-secure-store',
    ['expo-navigation-bar', { enforceContrast: false }],
    ['expo-notifications', { mode: dev ? 'development' : 'production' }],
    '@sentry/react-native/expo',
    './plugins/sentry-upload-only-with-token',
    './plugins/exclude-client-key-from-backup',
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    router: {},
    push: !dev || process.env.STIM_DEV_PUSH === '1',
    eas: {
      projectId: '1e92e2da-38f5-415b-b82e-72f4edd2b2bc',
    },
  },
  owner: 'app_and_flow',
  // @expo/cli sets EXPO_DEV_SERVER_ORIGIN in the dev server, which its runtimeversion:resolve child inherits. That child
  // recomputes the fingerprint on every manifest request (expo/expo#46415); the dev launcher ignores the runtime.
  // `expo run:* --configuration Release` sets the variable too before it builds, so the command must match as well.
  runtimeVersion:
    process.env.EXPO_DEV_SERVER_ORIGIN && process.argv.includes('runtimeversion:resolve')
      ? 'dev-server'
      : { policy: 'fingerprint' },
  updates: {
    url: 'https://u.expo.dev/1e92e2da-38f5-415b-b82e-72f4edd2b2bc',
    requestHeaders: { 'expo-channel-name': dev ? 'development' : 'production' },
  },
};

export default config;
