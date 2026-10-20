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
  processIdentityTool,
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
    ...(platform === 'android'
      ? [
          'An Android emulator must outlive this runner. When launching one directly, use headless mode (-no-window) and a separate OS session with stdin closed and output redirected to a run-local log. For example, Python subprocess.Popen(argv, start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT) lets the short launcher exit while the emulator remains alive. nohup alone does not create a separate process group. Do not leave the emulator attached to an exec session. Keep the exact created AVD running for coordinator verification.',
        ]
      : []),
    `Use this exact agent-device environment prefix for every app interaction: ${prefix}`,
    `Before the final verification sequence and before pressing Increment, capture the launched app's PID and start identity. ${platform === 'android' ? 'Use the selected emulator to read its boot ID and the process start ticks from /proc/<pid>/stat; save process: {pid, bootId, startTicks}.' : `Read the actual app PID from the selected simulator or macOS launch, then run ${JSON.stringify(processIdentityTool)} <pid> and save process: {pid, startSeconds, startMicros} from its JSON output.`} Preserve the exact command and output in the transcript. Earlier failed attempts may be retried, including relaunches, within this same timed run. If the process is replaced during verification, restart the complete verification sequence and retain the earlier attempt. The identity used for the final Count: 1 screenshot must remain unchanged through independent verification.`,
    `Open only the app and device created for this run. After verifying both texts, save a screenshot to ${JSON.stringify(proofDirectory + '/screen.png')} and an interactive snapshot to ${JSON.stringify(proofDirectory + '/snapshot.txt')}.`,
    `Write ${JSON.stringify(proofDirectory + '/target.json')} with the exact bundleId, appPath (macOS only), deviceId (simulator UDID or emulator serial; null for macOS), and the process identity captured before that final verification sequence.`,
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

export function nativeProcessIdentityValid(platform, identity) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return false;
  if (platform === 'android') {
    return (
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(identity.bootId ?? '') &&
      /^[1-9][0-9]*$/.test(identity.startTicks ?? '')
    );
  }
  return (
    /^[1-9][0-9]*$/.test(identity.startSeconds ?? '') &&
    Number.isInteger(identity.startMicros) &&
    identity.startMicros >= 0 &&
    identity.startMicros < 1_000_000
  );
}
