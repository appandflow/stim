const GITHUB_PULL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

export function isGitHubPullUrl(url: string): boolean {
  return GITHUB_PULL.test(url);
}
