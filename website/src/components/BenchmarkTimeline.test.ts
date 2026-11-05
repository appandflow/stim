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
  it('shows measurement warnings for an otherwise valid outcome', () => {
    const run = {
      ...opus.runs[0],
      valid: true,
      measurementWarnings: ['platform-command-target-exceeded'],
    } as BenchmarkRun;
    expect(render(run).textContent).toContain('platform-command-target-exceeded');
    expect(render({ ...run, measurementWarnings: [] }).textContent).not.toContain('Measurement warnings');
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
});
