import { describe, expect, it } from 'vitest';
import { daemonMode } from '../daemon/mode.ts';

describe('daemonMode with a leftover maintenance.mode', () => {
  it.each([
    ['off', { maintenance: { mode: 'off' } }, 'off'],
    ['report', { maintenance: { mode: 'report' } }, 'report'],
    ['on', { maintenance: { mode: 'on' } }, 'on'],
    ['daemon.mode set', { daemon: { mode: 'on' }, maintenance: { mode: 'off' } }, 'on'],
  ])('caps at %s', (_name, value, expected) => {
    expect(daemonMode({}, { projects: {}, repos: {}, ...value })).toBe(expected);
  });

  it('lets STIM_DAEMON win', () => {
    expect(daemonMode({ STIM_DAEMON: 'on' }, { projects: {}, repos: {}, maintenance: { mode: 'off' } })).toBe('on');
  });
});
