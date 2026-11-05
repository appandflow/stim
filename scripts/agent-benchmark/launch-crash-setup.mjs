export function launchCrashSetup({ platform, arm, systemImage }) {
  if (!['ios', 'android'].includes(platform) || !['stim', 'control'].includes(arm)) {
    throw new Error('launch-error setup requires a supported platform and arm');
  }
  if (platform === 'android' && !/^system-images;android-\d+;[a-zA-Z0-9_-]+;arm64-v8a$/.test(systemImage ?? '')) {
    throw new Error('Android launch-error setup requires the pinned arm64 system image');
  }
  const deviceKind = platform === 'ios' ? 'simulator' : 'AVD';
  const ignoredPaths =
    platform === 'ios'
      ? ['node_modules', 'ios/Pods', 'ios/build']
      : ['node_modules', 'android/.gradle', 'android/.cxx', 'android/app/build', 'android/local.properties'];
  return { ignoredPaths, deviceKind };
}
