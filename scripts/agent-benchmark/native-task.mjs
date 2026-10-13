export function nativeTaskPrompt({
  arm,
  platform,
  fixture,
  worktree,
  branch,
  marker,
  device,
  proofDirectory,
  session,
  stateDirectory,
}) {
  if (!['stim', 'control'].includes(arm) || !['ios', 'android', 'macos'].includes(platform)) {
    throw new Error('Unsupported native benchmark arm or platform');
  }
  const prefix = `env AGENT_DEVICE_STATE_DIR=${JSON.stringify(stateDirectory)} AGENT_DEVICE_SESSION=${JSON.stringify(session)} agent-device`;
  const tool =
    arm === 'stim'
      ? 'Use Stim for workspace preparation, building and launching. Follow its installed skill.'
      : 'Use the native platform tools directly. Do not use Stim or read its implementation, state, documentation or skill.';
  return [
    `Create a new git worktree at ${JSON.stringify(worktree)} on branch ${JSON.stringify(branch)} from ${JSON.stringify(fixture)}.`,
    `In this standalone native ${platform} app, change the visible revision text to ${JSON.stringify(marker)}. Build and launch the Debug app, press Increment once, and verify that the app displays the new revision and Count: 1.`,
    tool,
    `Target: ${device}. Dependencies and untimed native build outputs are available in the source checkout. Do not install or upgrade dependencies.`,
    'Keep finite shell commands attached to the current turn. Retain each running session handle and poll it to a terminal exit status before dependent commands. Preserve failing exit codes in pipelines.',
    `Use this exact agent-device environment prefix for every app interaction: ${prefix}`,
    `Open only the app and device created for this run. After verifying both texts, save a screenshot to ${JSON.stringify(proofDirectory + '/screen.png')} and an interactive snapshot to ${JSON.stringify(proofDirectory + '/snapshot.txt')}.`,
    `Write ${JSON.stringify(proofDirectory + '/target.json')} with the exact bundleId, appPath (macOS only), and deviceId (simulator UDID or emulator serial; null for macOS).`,
    'Leave the app, device, worktree and agent-device session running for independent coordinator verification. Do not stop or remove them.',
  ].join('\n\n');
}

export function nativeSourceProof({ before, after, marker, changedPaths, source }) {
  const expected = before.replace('native-revision-one', marker);
  return (
    before.includes('native-revision-one') &&
    after === expected &&
    changedPaths.length === 1 &&
    changedPaths[0] === source
  );
}
