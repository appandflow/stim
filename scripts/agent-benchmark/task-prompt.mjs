export function benchmarkTaskPrompt({ arm, platform, variant, source, worktree, branch, marker, device, proof }) {
  const task =
    variant === 'launch-crash'
      ? 'The app fails on launch. Reproduce it and capture the runtime error before inspecting application source, fix it, and verify the repair.'
      : variant === 'javascript'
        ? 'Change the Settings offline-map subtitle from "Keep map tiles for saved trails on device" to "Keep saved trail maps available offline".'
        : platform === 'ios'
          ? `Set the main iOS window accessibility identifier to ${JSON.stringify(marker)}.`
          : `Change the Android application label to ${JSON.stringify(marker)}.`;
  return [
    `Create an isolated git worktree from ${source} at ${worktree} on branch ${branch}, and work there. Installed dependencies and native outputs are available in the source checkout.`,
    task,
    arm === 'stim' ? 'Use Stim and its installed skill.' : "Use the project's standard tooling. Do not use Stim.",
    `Run the Debug app on ${device}. Use only the device assigned to this run.`,
    'Verify the result in the app with agent-device, handle any onboarding, and save a Settings screenshot and simulator recording. Keep the app running until proof is saved. Make no unrelated changes.',
    `Run constraints: preserve the supplied environment and tool versions; do not install dependencies, access other runs, or use subagents. ${proof}`,
  ].join('\n\n');
}
