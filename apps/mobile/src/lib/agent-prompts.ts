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

export function pickPrompts(pool: readonly string[], count: number): string[] {
  const items = [...pool];
  const n = Math.min(count, items.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (items.length - i));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items.slice(0, n);
}
