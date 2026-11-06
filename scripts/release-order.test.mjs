import { phoneApiProblem, desktopApiProblem, tagOrderProblem } from './release-order.mjs';

test('phoneApi requires the live runtime or native build approval', () => {
  const fixture = { before: 1, after: 2, fingerprint: 'live', runtime: 'live', labels: [] };
  expect(phoneApiProblem(fixture)).toBeNull();
  expect(phoneApiProblem({ ...fixture, fingerprint: 'unshipped' })).toContain('differs');
  expect(phoneApiProblem({ ...fixture, fingerprint: 'unshipped', labels: ['native-build-approved'] })).toBeNull();
});

test('desktopApi requires a matching Desktop', () => {
  const fixture = { before: 0, after: 1, swift: 'let desktopApi = 1' };
  expect(desktopApiProblem(fixture)).toBeNull();
  expect(desktopApiProblem({ ...fixture, swift: 'let desktopApi = 2' })).toContain('matching');
});

test('stable publication requires npm, then Desktop, then the phone update', () => {
  const release = {
    path: '.github/workflows/release.yml',
    head_sha: 'sha',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'v1.42.0',
  };
  const desktop = { ...release, path: '.github/workflows/desktop-release.yml', head_branch: 'desktop-v0.9.0' };
  expect(tagOrderProblem('desktop', '1.42.0', 'sha', '1.42.0', [release])).toBeNull();
  expect(tagOrderProblem('desktop', '1.42.0', 'sha', '1.41.0', [release])).toContain('Publish');
  expect(tagOrderProblem('mobile', '1.42.0', 'sha', '1.42.0', [release, desktop], '0.9.0')).toBeNull();
  expect(tagOrderProblem('mobile', '1.42.0', 'sha', '1.42.0', [release, desktop], '0.8.0')).toContain(
    'desktop-release',
  );
});
