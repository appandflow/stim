import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import NativeBenchmarkResults from './NativeBenchmarkResults';
import data from '../data/benchmarks/native-luna-1.20.2.json';
vi.mock('@docusaurus/useBaseUrl', () => ({ default: (path: string) => path }));

it('keeps native task time, pilot scope, and verified proof separate from readiness results', () => {
  const html = renderToStaticMarkup(createElement(NativeBenchmarkResults));
  expect(html).toContain('Total task time');
  expect(html).toContain('One pair');
  for (const pair of data.pairs) {
    for (const run of pair.runs) expect(html).toContain(`/benchmarks/native-luna-1.20.2/${run.proof}`);
  }
  expect(html).toContain('Native iOS');
  expect(html).toContain('Native macOS');
  expect(html).not.toContain('android-stim.png');
  expect(html).toContain('returned tier unverified');
});
