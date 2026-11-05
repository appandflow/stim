import { expect, it } from 'vitest';
import { benchmarkTaskPrompt } from './task-prompt.mjs';

const input = {
  platform: 'ios',
  source: '/fixture',
  worktree: '/run',
  branch: 'bench/run',
  marker: 'Trailhead test',
  device: 'the assigned device',
  proof: 'Save evidence in /proof.',
};

it.each(['javascript', 'native', 'launch-crash'])(
  'gives both arms the same %s task, constraints and evidence requirements',
  (variant) => {
    const stim = benchmarkTaskPrompt({ ...input, variant, arm: 'stim' });
    const control = benchmarkTaskPrompt({ ...input, variant, arm: 'control' });
    expect(stim.replace('Use Stim and its installed skill.', '')).toBe(
      control.replace("Use the project's standard tooling. Do not use Stim.", ''),
    );
    expect(stim).not.toMatch(
      /stim (?:start|ios|android|logs|worktree)|rsync|cp -|nohup|pipefail|session_id|RootLayout|_layout\.tsx|deterministic|initial root/,
    );
    expect(stim).toContain('/run');
    expect(stim).toContain('/proof');
  },
);

it('specifies native outcomes without giving source locations or code edits', () => {
  const ios = benchmarkTaskPrompt({ ...input, variant: 'native', arm: 'control' });
  const android = benchmarkTaskPrompt({ ...input, platform: 'android', variant: 'native', arm: 'control' });
  expect(ios).toContain('window accessibility identifier to "Trailhead test"');
  expect(android).toContain('application label to "Trailhead test"');
  expect(ios + android).not.toMatch(/AppDelegate|strings\.xml|window assignment/);
});
