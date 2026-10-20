import { isGitHubPullUrl } from '@/lib/github';

describe('isGitHubPullUrl', () => {
  it('accepts a GitHub pull request', () => {
    expect(isGitHubPullUrl('https://github.com/appandflow/stim/pull/3335')).toBe(true);
  });

  it.each([
    ['a non-GitHub https URL', 'https://evil.example/appandflow/stim/pull/1'],
    ['a lookalike host', 'https://github.com.evil.example/appandflow/stim/pull/1'],
    ['a custom scheme', 'otherapp://github.com/appandflow/stim/pull/1'],
    ['plain http', 'http://github.com/appandflow/stim/pull/1'],
    ['a GitHub page that is not a pull request', 'https://github.com/appandflow/stim/issues/1'],
    ['a pull request with a trailing path', 'https://github.com/appandflow/stim/pull/1/files'],
  ])('refuses %s', (_name, url) => {
    expect(isGitHubPullUrl(url)).toBe(false);
  });
});
