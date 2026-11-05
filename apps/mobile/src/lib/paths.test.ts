import { relativeTo, tildeHome } from '@/lib/paths';

describe('tildeHome', () => {
  const home = '/Users/janic';

  it('shortens the home folder and paths under it', () => {
    expect(tildeHome('/Users/janic/Developer/tlon-apps/.worktrees/x/apps/tlon-mobile', home)).toBe(
      '~/Developer/tlon-apps/.worktrees/x/apps/tlon-mobile',
    );
    expect(tildeHome('/Users/janic', home)).toBe('~');
    expect(tildeHome('/Users/janic/a', `${home}/`)).toBe('~/a');
  });

  it('matches whole path segments only', () => {
    expect(tildeHome('/Users/janicduplessis/app', home)).toBe('/Users/janicduplessis/app');
    expect(tildeHome('/Users/janic/app', '/Users/jan')).toBe('/Users/janic/app');
    expect(tildeHome('/tmp/Users/janic/app', home)).toBe('/tmp/Users/janic/app');
  });

  it('shortens paths inside a sentence', () => {
    expect(tildeHome('Worktree /Users/janic/a is missing; see /Users/janicd/b and "/Users/janic/c".', home)).toBe(
      'Worktree ~/a is missing; see /Users/janicd/b and "~/c".',
    );
  });

  it('leaves text alone without a known home', () => {
    expect(tildeHome('/Users/janic/a', undefined)).toBe('/Users/janic/a');
  });
});

describe('relativeTo', () => {
  it('writes paths under the root relative to it, and leaves the root itself and other paths alone', () => {
    expect(relativeTo('SyntaxError: /tmp/app/App.js: Unexpected token', '/tmp/app/')).toBe(
      'SyntaxError: App.js: Unexpected token',
    );
    expect(relativeTo('at x (/tmp/app/node_modules/a.js:1:2) in /tmp/app', '/tmp/app')).toBe(
      'at x (node_modules/a.js:1:2) in /tmp/app',
    );
    expect(relativeTo('/tmp/apple/App.js', '/tmp/app')).toBe('/tmp/apple/App.js');
  });
});
