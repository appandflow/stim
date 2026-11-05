import type { StimContext } from '@stim-cli/core';

export function testContext(overrides: Partial<StimContext> = {}): StimContext {
  return {
    home: process.env.STIM_HOME ?? '/nonexistent-stim-home',
    buildCache: null,
    projectRoot: process.cwd(),
    env: process.env,
    cwd: process.cwd(),
    runId: 'test-run',
    signal: new AbortController().signal,
    output: () => {},
    ...overrides,
  };
}
