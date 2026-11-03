import { expect, it } from 'vitest';
import { adbInputArgs, parseInput, type SessionTarget } from '../src/control.ts';

const target = (platform: SessionTarget['platform']): SessionTarget => ({ platform, postures: [] });
const parse = (platform: SessionTarget['platform'], params: Record<string, unknown>) =>
  parseInput('input.key', { session: 's', ...params }, () => target(platform));

it.each(['ios', 'android'] as const)('accepts the arrows and Escape as input.key on %s', (platform) => {
  for (const key of ['left', 'right', 'up', 'down', 'escape']) {
    expect(parse(platform, { key })).toEqual({
      value: { session: 's', command: { input: 'key', key, modifiers: [] } },
    });
  }
});

it.each(['ios', 'android'] as const)('refuses other keys and any modifier as input.key on %s', (platform) => {
  for (const params of [
    { key: 'tab' },
    { key: 'a' },
    { key: 'return' },
    { key: 'f1' },
    { key: 'left', modifiers: ['shift'] },
    { key: 'left', modifiers: 'shift' },
    {},
  ]) {
    expect(parse(platform, params)).toHaveProperty('code', 'bad-request');
  }
});

it('keeps input.key for a web page refused and for a macOS window unchanged', () => {
  expect(parse('web', { key: 'left' })).toHaveProperty('code', 'bad-request');
  expect(parse('macos', { key: 'a', modifiers: ['command'] })).toHaveProperty('value');
  expect(parse('macos', { key: 'left' })).toHaveProperty('value');
});

it('presses the Android D-pad and Escape key events for input.key over adb', () => {
  const keys = [
    ['left', 'DPAD_LEFT'],
    ['right', 'DPAD_RIGHT'],
    ['up', 'DPAD_UP'],
    ['down', 'DPAD_DOWN'],
    ['escape', 'ESCAPE'],
  ] as const;
  for (const [key, code] of keys) {
    expect(adbInputArgs({ input: 'key', key, modifiers: [] })).toEqual([
      ['shell', 'input', 'keyevent', `KEYCODE_${code}`],
    ]);
  }
});

const touch = (platform: SessionTarget['platform'], params: Record<string, unknown>, extra?: Partial<SessionTarget>) =>
  parseInput('input.touch', { session: 's', phase: 'down', x: 0.25, y: 0.5, ...params }, () => ({
    ...target(platform),
    ...extra,
  }));

it.each(['ios', 'android'] as const)('passes a second finger on as part of one input.touch on %s', (platform) => {
  expect(touch(platform, { x2: 0.75, y2: 0.5 })).toEqual({
    value: { session: 's', command: { input: 'touch', phase: 'down', x: 0.25, y: 0.5, x2: 0.75, y2: 0.5 } },
  });
  expect(touch(platform, {})).toEqual({
    value: { session: 's', command: { input: 'touch', phase: 'down', x: 0.25, y: 0.5 } },
  });
});

it('takes the second finger as a pair of fractions or not at all', () => {
  for (const params of [
    { x2: 0.5 },
    { y2: 0.5 },
    { x2: 1.5, y2: 0.5 },
    { x2: 0.5, y2: -0.1 },
    { x2: '0.5', y2: 0.5 },
  ]) {
    expect(touch('ios', params)).toHaveProperty('code', 'bad-request');
  }
});

it('refuses a second finger where only one pointer exists', () => {
  const two = { x2: 0.75, y2: 0.5 };
  expect(touch('web', two)).toHaveProperty('code', 'bad-request');
  expect(touch('macos', two)).toHaveProperty('code', 'bad-request');
  expect(touch('ios', two, { postures: ['folded', 'unfolded'] })).toHaveProperty('code', 'bad-request');
  expect(touch('android', two, { postures: ['folded', 'unfolded'] })).toHaveProperty('value');
});
