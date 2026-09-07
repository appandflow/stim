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
      : [
          'node_modules',
          'android/.gradle',
          'android/.cxx',
          'android/build',
          'android/app/build',
          'android/local.properties',
        ];
  const platformCommand = platform === 'ios' ? 'stim ios' : `stim android --system-image '${systemImage}'`;
  const device = platform === 'ios' ? 'adopted simulator' : 'owned emulator';
  const stim = `Use the Stim skill and only the pinned command available on PATH as exactly \`stim\`. Keep the inherited STIM_HOME unchanged. Before inspecting source or git diff, run \`stim start\` and then \`${platformCommand}\` so the benchmark observes the failure. Preserve that launch output, then immediately run \`stim logs --errors\` as its own command. Diagnose the launch failure from those results. Only after the diagnostic commands may you inspect and edit source. Make the smallest repair and demonstrate the repaired Settings screen on the same ${device}. Leave Metro and the app running until screenshot proof is complete. Do not use npx, an absolute Stim path, raw Expo launch commands, or stop Stim.`;
  const controlDevice =
    platform === 'ios'
      ? 'Create a new iPhone 17 simulator running iOS 26.5 with the exact required name; do not substitute another device type or runtime and do not use an existing simulator.'
      : `Create a new AVD with the exact required name from ${JSON.stringify(systemImage)} using avdmanager's default hardware profile, matching Stim. Set disk.dataPartition.size=8589934592 in its config.ini, matching Stim. Boot this new emulator with default Quick Boot policy and wait for Android boot completion; do not use an existing emulator. Use its exact serial for Expo launch and every adb command. Build only the default Debug variant and arm64-v8a architecture. Use adb reverse for the app's Metro port before launch.`;
  const tooling = platform === 'ios' ? 'Apple' : 'Android SDK';
  const logs = platform === 'ios' ? 'simulator-log' : '`adb -s <run serial> logcat -d`';
  const control = `Use the project's local Expo and ${tooling} tooling and do not use Stim. ${controlDevice} Before inspecting source or git diff, start Metro as a detached process with its PID and log under /tmp. Start the initial native build/install/launch as a detached shell process with its PID and log under /tmp, then poll it with short foreground shell commands such as \`kill -0 <pid>\` and \`tail\`. Once the app has launched and failed, run a separate foreground \`tail\`, \`rg\`, or ${logs} command that completes and prints the crash token and source location. Only after that explicit error-capture command completes may you inspect or edit source. Make the smallest repair and demonstrate the repaired Settings screen on the same ${platform === 'ios' ? 'simulator' : 'emulator'}. Leave Metro and the app running until screenshot proof is complete. Do not use a long-running foreground shell command, concurrent shell tool calls, or rely on streamed output from a command that is still running as diagnosis evidence.`;
  return { ignoredPaths, deviceKind, instructions: arm === 'stim' ? stim : control };
}
