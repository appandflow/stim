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
  version: '0.1.0',
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
    appleTeamId: 'R7E8P23K3N',
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
        backgroundColor: '#FFFFFF',
        image: './assets/images/icon.png',
        imageWidth: 120,
        dark: {
          backgroundColor: '#15121D',
          image: './assets/images/icon.png',
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
    ['expo-notifications', { mode: dev ? 'development' : 'production' }],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
    inlineModules: {
      watchedDirectories: ['modules/stim-video/ios', 'modules/stim-video/android'],
    },
  },
  extra: {
    router: {},
    push: !dev || process.env.STIM_DEV_PUSH === '1',
    eas: {
      projectId: '1e92e2da-38f5-415b-b82e-72f4edd2b2bc',
    },
  },
  owner: 'app_and_flow',
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    url: 'https://u.expo.dev/1e92e2da-38f5-415b-b82e-72f4edd2b2bc',
    requestHeaders: { 'expo-channel-name': dev ? 'development' : 'production' },
  },
};

export default config;
