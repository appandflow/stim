import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import BenchmarkTimeline from './BenchmarkTimeline';
import opus from '../data/benchmarks/opus-ios-launch-error.json';
import type { BenchmarkRun } from './benchmarkData';

vi.mock('@docusaurus/useBaseUrl', () => ({ default: (path: string) => path }));

const { JSDOM } = await vi.importActual<{ JSDOM: new (html: string) => { window: { document: Document } } }>('jsdom');

function render(run: BenchmarkRun): HTMLElement {
  return new JSDOM(renderToStaticMarkup(createElement(BenchmarkTimeline, { run }))).window.document.body;
}

describe('benchmark timeline presentation', () => {
  it('names the keyboard-scrollable timeline and exposes playback time to assistive technology', () => {
    const run = { ...opus.runs[0], totalSeconds: 90 } as BenchmarkRun;
    const view = render(run);
    expect(
      view.querySelector('[role="region"][aria-label="Benchmark command timeline"]')?.getAttribute('tabindex'),
    ).toBe('0');
    expect(view.querySelector('input[aria-label="Playback position"]')?.getAttribute('aria-valuetext')).toBe(
      '0.0s of 1m 30s',
    );
  });

  it('shows full-run Claude usage even when diagnosis usage is absent', () => {
    const run: BenchmarkRun = {
      ...(opus.runs[0] as BenchmarkRun),
      usage: { input_tokens: 360_000, cached_input_tokens: 300_000, output_tokens: 8_000, reasoning_output_tokens: 0 },
      estimatedTokenCostUsd: 0.54,
      diagnosisUsage: null,
      estimatedDiagnosisCostUsd: null,
    };
    const view = render(run);
    expect(view.textContent).toContain('368k');
    expect(view.textContent).toContain('$0.540');
  });

  it('labels missing full-run usage unavailable instead of inventing zero cost', () => {
    const run: BenchmarkRun = {
      ...(opus.runs[1] as BenchmarkRun),
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      estimatedTokenCostUsd: null,
    };
    const view = render(run);
    for (const label of ['Total tokens', 'Total cost']) {
      const name = [...view.querySelectorAll('*')].find((node) => node.textContent === label);
      expect(
        [...(name?.parentElement?.querySelectorAll('*') ?? [])].some((node) => node.textContent === 'unavailable'),
      ).toBe(true);
    }
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
    const view = render(run);
    expect(view.querySelector('button[aria-label="stim worktree warm, 5.0s, exit 0"]')).not.toBeNull();
    expect(
      [...view.querySelectorAll('details pre')].some(
        (node) => node.textContent === 'cd ./worktrees/run && stim worktree warm',
      ),
    ).toBe(true);
    expect(
      [...view.querySelectorAll('pre')].some((node) => node.textContent === '$ stim worktree warm\n\ncopy complete'),
    ).toBe(true);
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
    const view = render(run);
    expect(
      [...view.querySelectorAll('pre')].some((node) => node.textContent === '$ agent-device wait text "Settings"'),
    ).toBe(true);
  });
});
