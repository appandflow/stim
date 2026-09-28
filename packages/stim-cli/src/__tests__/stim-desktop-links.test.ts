import { expect, test } from 'vitest';
import { workspaceLinks } from '../devices/stim-desktop.ts';

const installed = () => true;

test('the link round-trips a path with spaces and URL delimiters, keeping slashes readable', () => {
  const root = '/Users/me/My Apps/a&b #1+x';
  const link = workspaceLinks(root, undefined, installed)!.desktop;
  expect(link).toBe('stim-desktop://workspace?path=/Users/me/My%20Apps/a%26b%20%231%2Bx');
  const url = new URL(link);
  expect(url.searchParams.get('path')).toBe(root);
  expect([...url.searchParams.keys()]).toEqual(['path']);
});

test('a device run names its platform, and its slot unless it is the default one', () => {
  expect(workspaceLinks('/w', { platform: 'ios', slot: 'default' }, installed)).toEqual({
    desktop: 'stim-desktop://workspace?path=/w&platform=ios',
  });
  expect(workspaceLinks('/w', { platform: 'android', slot: 'tablet b' }, installed)).toEqual({
    desktop: 'stim-desktop://workspace?path=/w&platform=android&slot=tablet%20b',
  });
});

test('no link when no app on this Mac opens stim-desktop links', () => {
  expect(workspaceLinks('/w', { platform: 'web' }, () => false)).toBeUndefined();
});
