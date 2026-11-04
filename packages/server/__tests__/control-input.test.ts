import { expect, it } from 'vitest';
import { adbInputArgs, parseInput, pasteTypingChunks, type SessionTarget } from '../src/control.ts';
import { MAX_CLIPBOARD_BYTES } from '../src/protocol.ts';

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

const clipboardSet = (
  platform: SessionTarget['platform'],
  params: Record<string, unknown>,
  extra?: Partial<SessionTarget>,
) => parseInput('input.clipboard.set', { session: 's', ...params }, () => ({ ...target(platform), ...extra }));
const clipboardGet = (
  platform: SessionTarget['platform'],
  params: Record<string, unknown> = {},
  extra?: Partial<SessionTarget>,
) => parseInput('input.clipboard.get', { session: 's', ...params }, () => ({ ...target(platform), ...extra }));

it.each(['ios', 'android'] as const)('takes Unicode clipboard text with an optional paste flag on %s', (platform) => {
  expect(clipboardSet(platform, { text: 'h\u00e9llo \u{1f600}\n"x"', paste: true })).toEqual({
    value: { session: 's', command: { input: 'clipboard', text: 'h\u00e9llo \u{1f600}\n"x"', paste: true } },
  });
  expect(clipboardSet(platform, { text: 'abc' })).toEqual({
    value: { session: 's', command: { input: 'clipboard', text: 'abc', paste: false } },
  });
  expect(clipboardGet(platform)).toEqual({ value: { session: 's', command: { input: 'clipboard-get' } } });
});

it('counts the clipboard limit in UTF-8 bytes, not characters', () => {
  expect(clipboardSet('ios', { text: 'a'.repeat(MAX_CLIPBOARD_BYTES) })).toHaveProperty('value');
  expect(clipboardSet('ios', { text: 'a'.repeat(MAX_CLIPBOARD_BYTES + 1) })).toHaveProperty('code', 'bad-request');
  expect(clipboardSet('ios', { text: '\u00e9'.repeat(MAX_CLIPBOARD_BYTES / 2) })).toHaveProperty('value');
  expect(clipboardSet('ios', { text: '\u00e9'.repeat(MAX_CLIPBOARD_BYTES / 2 + 1) })).toHaveProperty(
    'code',
    'bad-request',
  );
});

it('takes text only: a missing or non-string text, a non-boolean paste and any text on a read are refused', () => {
  for (const params of [{}, { text: 7 }, { text: null }, { text: ['a'] }, { text: 'a', paste: 'yes' }]) {
    expect(clipboardSet('ios', params)).toHaveProperty('code', 'bad-request');
  }
  expect(clipboardGet('ios', { text: 'a' })).toHaveProperty('code', 'bad-request');
  expect(clipboardGet('ios', { paste: true })).toHaveProperty('code', 'bad-request');
});

it('refuses the clipboard on a web page, a native macOS app and a physical iPhone', () => {
  for (const [platform, extra] of [
    ['web', undefined],
    ['macos', undefined],
    ['ios', { physical: true }],
  ] as const) {
    expect(clipboardSet(platform, { text: 'a' }, extra)).toHaveProperty('code', 'bad-request');
    expect(clipboardGet(platform, {}, extra)).toHaveProperty('code', 'bad-request');
  }
  expect(clipboardSet('android', { text: 'a' }, { physical: true })).toHaveProperty('value');
});

it('splits a typeable paste into input.text pieces and turns CRLF into one Return', () => {
  expect(pasteTypingChunks('hello')).toEqual(['hello']);
  expect(pasteTypingChunks('x'.repeat(256))).toEqual(['x'.repeat(256)]);
  expect(pasteTypingChunks('x'.repeat(257))).toEqual(['x'.repeat(256), 'x']);
  expect(pasteTypingChunks(`a\tb\r\nc\n${'y'.repeat(600)}`)?.join('')).toBe(`a\tb\nc\n${'y'.repeat(600)}`);
});

it('leaves a paste to Command-V when the HID keyboard cannot type it', () => {
  for (const text of ['', 'h\u00e9llo', 'smile \u{1f600}', 'bell\u0007', 'back\bspace', 'lone\rreturn']) {
    expect(pasteTypingChunks(text)).toBeNull();
  }
});
