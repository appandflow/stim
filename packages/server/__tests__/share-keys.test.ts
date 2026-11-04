import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

interface Press {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  altGraph?: boolean;
}

const { keyMessage }: { keyMessage: (event: unknown, apple: boolean) => unknown } = runInNewContext(
  `${readFileSync(new URL('../share-viewer/keys.js', import.meta.url), 'utf8')}\nglobalThis.stimKeys`,
);

const press = (event: Press, apple = true) =>
  keyMessage(
    {
      code: '',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...event,
      getModifierState: () => event.altGraph === true,
    },
    apple,
  );

it('types printable characters and sends the arrows and Escape as keys, as before', () => {
  expect(press({ key: 'a' })).toEqual({ type: 'text', text: 'a' });
  expect(press({ key: 'Enter' })).toEqual({ type: 'text', text: '\n' });
  expect(press({ key: 'Backspace' })).toEqual({ type: 'text', text: '\b' });
  expect(press({ key: 'ArrowLeft' })).toEqual({ type: 'key', key: 'left' });
  expect(press({ key: 'Escape' })).toEqual({ type: 'key', key: 'escape' });
  expect(press({ key: 'F5' })).toBeNull();
  expect(press({ key: 'Shift' })).toBeNull();
});

it('sends Shift with an arrow as a key with its modifier', () => {
  expect(press({ key: 'ArrowLeft', shiftKey: true })).toEqual({ type: 'key', key: 'left', modifiers: ['shift'] });
});

it('sends a chord as a key with its modifiers, Command on a Mac and Control elsewhere', () => {
  expect(press({ key: 'a', code: 'KeyA', metaKey: true })).toEqual({ type: 'key', key: 'a', modifiers: ['command'] });
  expect(press({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true })).toEqual({
    type: 'key',
    key: 'z',
    modifiers: ['command', 'shift'],
  });
  expect(press({ key: 'ArrowLeft', altKey: true, shiftKey: true })).toEqual({
    type: 'key',
    key: 'left',
    modifiers: ['shift', 'option'],
  });
  expect(press({ key: '1', code: 'Digit1', ctrlKey: true })).toEqual({ type: 'key', key: '1', modifiers: ['control'] });
  expect(press({ key: 'a', code: 'KeyA', ctrlKey: true }, false)).toEqual({
    type: 'key',
    key: 'a',
    modifiers: ['command'],
  });
  expect(press({ key: 'Tab', ctrlKey: true })).toEqual({ type: 'key', key: 'tab', modifiers: ['control'] });
});

it('leaves paste to the page, and keys it cannot name or the Windows key to the browser', () => {
  expect(press({ key: 'v', code: 'KeyV', metaKey: true })).toBeNull();
  expect(press({ key: 'v', code: 'KeyV', ctrlKey: true }, false)).toBeNull();
  expect(press({ key: 'F5', metaKey: true })).toBeNull();
  expect(press({ key: ',', code: 'Comma', metaKey: true })).toBeNull();
  expect(press({ key: 'a', code: 'KeyA', metaKey: true }, false)).toBeNull();
});

it('types a character produced with AltGr instead of sending a chord', () => {
  expect(press({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, altGraph: true }, false)).toEqual({
    type: 'text',
    text: '@',
  });
});

it('names a chord by the character the layout types, and by the physical key when that is not a Latin letter', () => {
  expect(press({ key: 'a', code: 'KeyQ', metaKey: true })).toEqual({ type: 'key', key: 'a', modifiers: ['command'] });
  expect(press({ key: 'z', code: 'KeyY', metaKey: true })).toEqual({ type: 'key', key: 'z', modifiers: ['command'] });
  expect(press({ key: 'c', code: 'KeyJ', metaKey: true })).toEqual({ type: 'key', key: 'c', modifiers: ['command'] });
  expect(press({ key: '\u044F', code: 'KeyZ', metaKey: true })).toEqual({
    type: 'key',
    key: 'z',
    modifiers: ['command'],
  });
  expect(press({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true })).toEqual({
    type: 'key',
    key: '1',
    modifiers: ['command', 'shift'],
  });
});

it('types an ASCII character made with Option on a Mac, and keeps Option chords otherwise', () => {
  expect(press({ key: '@', code: 'KeyL', altKey: true })).toEqual({ type: 'text', text: '@' });
  expect(press({ key: '\u00E5', code: 'KeyA', altKey: true })).toEqual({
    type: 'key',
    key: 'a',
    modifiers: ['option'],
  });
  expect(press({ key: '@', code: 'KeyL', altKey: true, metaKey: true })).toEqual({
    type: 'key',
    key: 'l',
    modifiers: ['command', 'option'],
  });
  expect(press({ key: 'a', code: 'KeyA', altKey: true }, false)).toEqual({
    type: 'key',
    key: 'a',
    modifiers: ['option'],
  });
});
