import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import BenchmarkTimeline from './BenchmarkTimeline';
import opus from '../data/benchmarks/opus-ios-launch-error.json';
import type { BenchmarkRun } from './benchmarkData';

vi.mock('@docusaurus/useBaseUrl', () => ({ default: (path: string) => path }));

describe('benchmark timeline presentation', () => {
  it('shows full-run Claude usage even when diagnosis usage is absent', () => {
    const run = opus.runs[0] as BenchmarkRun;
    const html = renderToStaticMarkup(createElement(BenchmarkTimeline, { run }));
    expect(html).toContain('Total tokens');
    expect(html).toContain('368k');
    expect(html).toContain('$0.540');
    expect(html).not.toContain('Tokens to diagnosis');
    expect(html).not.toContain('Cost to diagnosis');
  });

  it('labels missing full-run usage unavailable instead of inventing zero cost', () => {
    const run = opus.runs[1] as BenchmarkRun;
    const html = renderToStaticMarkup(createElement(BenchmarkTimeline, { run }));
    expect(html).toContain('<span>Total tokens</span><strong>unavailable</strong>');
    expect(html).toContain('<span>Total cost</span><strong>unavailable</strong>');
  });

  it('uses concise command labels and terminal text with expandable original context', () => {
    const run = {
      ...opus.runs[0],
      commands: [
        {
          id: 'warm',
          command: 'cd ./worktrees/run && stim worktree warm',
          presentation: { command: 'stim worktree warm', cwd: './worktrees/run' },
          output: 'copy complete',
          startSeconds: 0,
          endSeconds: 5,
          exitCode: 0,
        },
      ],
    } as BenchmarkRun;
    const html = renderToStaticMarkup(createElement(BenchmarkTimeline, { run }));
    expect(html).toContain('aria-label="stim worktree warm, 5.0s, exit 0"');
    expect(html).toContain('<details><summary>Command context and original</summary>');
    expect(html).toContain('cd ./worktrees/run &amp;&amp; stim worktree warm');
    expect(html).toContain('$ </span>stim worktree warm\n\ncopy complete');
  });

  it('preserves closing quotes in displayed agent-device arguments', () => {
    const run = {
      ...opus.runs[0],
      commands: [
        {
          id: 'wait',
          command: 'agent-device wait text "Settings"',
          output: '',
          startSeconds: 0,
          endSeconds: 1,
          exitCode: 0,
        },
      ],
    } as BenchmarkRun;
    const html = renderToStaticMarkup(createElement(BenchmarkTimeline, { run }));
    expect(html).toContain('$ </span>agent-device wait text &quot;Settings&quot;');
  });
});
