/** Example prompts from the copyable agent prompts in website/docs, with the Android ones adapted from their iOS form. */
export const AGENT_PROMPTS = [
  'Run the app on iOS.',
  'Run the app on Android.',
  'Run the app on my connected iPhone.',
  'Run the app on an iOS simulator using an EAS build.',
  'Make this change in a separate worktree and validate it on iOS.',
  'Make this change in a separate worktree and validate it on Android.',
  'Show app errors from the last 10 minutes.',
  'Show iOS build performance.',
];

/**
 * Prompts for the Desktop Overview's "Try this" tips, keyed by the tip's id. Each names flags from `stim guide`; the
 * ones that touch `remote.*` settings only ask the agent to explain, since an agent never edits those.
 */
export const TRY_THIS_PROMPTS = {
  easProfile:
    'Run the app on an iOS simulator with an EAS development build. Read eas.json, pick the development profile that builds for the simulator, and run stim ios --eas-profile with it. If no profile fits, ask me.',
  easSimulator:
    'Run the app on an EAS cloud simulator with stim start --remote and then stim ios --remote eas. EAS bills the session, so run stim stop when we are done.',
  remoteBuild:
    'Read stim guide settings and tell me what I need to do to build on my other Mac with remote.machines and stim ios --remote-build. Do not change remote settings or approve anything yourself.',
  hostedSimulator:
    'Read stim guide lifecycle hosted-ios and tell me what I need to do to run the iOS simulator on my other Mac with stim ios --remote. Do not change remote settings or approve anything yourself.',
  macos:
    'Read stim guide macos, set macos.product and macos.infoPlist in .stim.json for this Swift package, and run it as a macOS app with stim macos.',
  physicalDevice:
    'Run the app on my connected iPhone with stim ios --device, or on my Android phone with stim android --device.',
  web: 'Start the dev server, open the app in the browser with stim web, and show me the page errors with stim logs --errors.',
  logs: 'Run the app on iOS, then show me only its errors with stim logs --errors.',
} as const;

export function pickPrompts(pool: readonly string[], count: number): string[] {
  const items = [...pool];
  const n = Math.min(count, items.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (items.length - i));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items.slice(0, n);
}
