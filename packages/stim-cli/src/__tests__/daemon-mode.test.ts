import { describe, expect, it } from 'vitest';
import { leftoverDaemonMode } from '@stim-cli/core/state';
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

describe('leftoverDaemonMode', () => {
  it.each([
    ['a leftover off', {}, { maintenance: { mode: 'off' } }, 'off'],
    ['daemon.mode set', {}, { daemon: { mode: 'on' }, maintenance: { mode: 'off' } }, null],
    ['STIM_DAEMON set', { STIM_DAEMON: 'on' }, { maintenance: { mode: 'off' } }, null],
  ])('%s', (_name, env, config, expected) => {
    expect(leftoverDaemonMode(config, env)).toBe(expected);
  });
});
