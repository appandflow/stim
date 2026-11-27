import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MAX_CLIPBOARD_BYTES } from '../src/protocol.ts';

interface Clipboard {
  pasteRequest: (text: unknown) => { message?: Record<string, unknown>; note?: string } | null;
  createClipboardSync: () => {
    browserRead: (text: unknown) => { message?: Record<string, unknown>; note?: string } | null;
    sent: (text: string) => void;
  };
}

const clipboard: Clipboard = runInNewContext(
  `${readFileSync(new URL('../share-viewer/clipboard.js', import.meta.url), 'utf8')}\nglobalThis.stimClipboard`,
  { TextEncoder },
);

describe('the viewer paste', () => {
  it('turns pasted text into a set-and-paste message, Unicode and newlines included', () => {
    expect(clipboard.pasteRequest('héllo \u{1f600}\nline "two"')).toEqual({
      message: { type: 'clipboard-set', text: 'héllo \u{1f600}\nline "two"', paste: true },
    });
  });

  it('sends nothing for an empty or missing clipboard', () => {
    expect(clipboard.pasteRequest('')).toBeNull();
    expect(clipboard.pasteRequest(null)).toBeNull();
  });

  it('shows a note instead of sending text over the same byte limit the server enforces', () => {
    expect(clipboard.pasteRequest('a'.repeat(MAX_CLIPBOARD_BYTES))).toHaveProperty('message');
    expect(clipboard.pasteRequest('a'.repeat(MAX_CLIPBOARD_BYTES + 1))).toEqual({ note: expect.any(String) });
    expect(clipboard.pasteRequest('é'.repeat(MAX_CLIPBOARD_BYTES / 2 + 1))).toEqual({ note: expect.any(String) });
  });
});

describe('the viewer clipboard sync', () => {
  const set = (text: string) => ({ message: { type: 'clipboard-set', text } });

  it('takes the first browser text, even an empty one, as the baseline and sends each later change', () => {
    const sync = clipboard.createClipboardSync();
    expect(sync.browserRead('')).toBeNull();
    expect(sync.browserRead('copied later')).toEqual(set('copied later'));
    sync.sent('copied later');
    expect(sync.browserRead('copied later')).toBeNull();
    expect(sync.browserRead('')).toBeNull();
  });

  it('offers a browser text again until it is sent, so a dropped send is retried', () => {
    const sync = clipboard.createClipboardSync();
    sync.browserRead('start');
    expect(sync.browserRead('wanted')).toEqual(set('wanted'));
    expect(sync.browserRead('wanted')).toEqual(set('wanted'));
    sync.sent('wanted');
    expect(sync.browserRead('wanted')).toBeNull();
  });

  it('shows the byte-limit note once for a text that is too long, and sends nothing', () => {
    const sync = clipboard.createClipboardSync();
    sync.browserRead('start');
    const long = 'a'.repeat(MAX_CLIPBOARD_BYTES + 1);
    expect(sync.browserRead(long)).toEqual({ note: expect.any(String) });
    expect(sync.browserRead(long)).toBeNull();
  });
});
