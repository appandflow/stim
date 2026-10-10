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

/** Prompts for Stim Desktop's sidebar tips that offer Copy Prompt, keyed by the tip's id. Each names flags from `stim guide`. */
export const TIP_PROMPTS = {
  easProfile:
    'Run the app on an iOS simulator with an EAS development build. Read eas.json, pick the development profile that builds for the simulator, and run stim ios --eas-profile with it. If no profile fits, ask me.',
  macos:
    'Read stim guide macos, set macos.product and macos.infoPlist in .stim.json for this Swift package, and run it as a macOS app with stim macos.',
  logs: 'Show me only the errors from the app, Metro and the build with stim logs --errors.',
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
