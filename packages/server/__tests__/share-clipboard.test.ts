import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { MAX_CLIPBOARD_BYTES } from '../src/protocol.ts';

interface Clipboard {
  pasteRequest: (text: unknown) => { message?: Record<string, unknown>; note?: string } | null;
  writeClipboard: (
    clipboard: Record<string, unknown>,
    ClipboardItemClass: unknown,
    BlobClass: unknown,
    text: Promise<string>,
  ) => Promise<unknown>;
  nextPollDelay: (current: number, ok: boolean) => number;
  createClipboardSync: () => {
    deviceRead: (text: unknown) => boolean;
    wrote: (text: string) => void;
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

describe('the viewer copy', () => {
  class Item {
    parts: Record<string, Promise<Blob>>;
    constructor(parts: Record<string, Promise<Blob>>) {
      this.parts = parts;
    }
  }

  it('hands the click a promise of the text through ClipboardItem, so the device can answer later', async () => {
    const write = vi.fn<(items: Item[]) => Promise<void>>(async () => {});
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    let resolve!: (text: string) => void;
    const text = new Promise<string>((done) => (resolve = done));
    const written = clipboard.writeClipboard({ write, writeText }, Item, Blob, text);
    expect(write).toHaveBeenCalledTimes(1);
    resolve('from the device');
    await written;
    const [item] = write.mock.calls[0]![0];
    expect(await (await item!.parts['text/plain']!).text()).toBe('from the device');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to writeText once the text arrived where ClipboardItem is missing', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    await clipboard.writeClipboard({ writeText }, undefined, Blob, Promise.resolve('copied'));
    expect(writeText).toHaveBeenCalledWith('copied');
  });

  it('fails the write when the device returns no text', async () => {
    const write = vi.fn<(items: Item[]) => Promise<void>>(async (items) => {
      await items[0]!.parts['text/plain'];
    });
    await expect(
      clipboard.writeClipboard({ write }, Item, Blob, Promise.reject(new Error('The device did not answer.'))),
    ).rejects.toThrow('The device did not answer.');
  });
});

describe('the viewer clipboard sync', () => {
  const set = (text: string) => ({ message: { type: 'clipboard-set', text } });

  it('only records the first device text, then asks for a browser write on each new one', () => {
    const sync = clipboard.createClipboardSync();
    expect(sync.deviceRead('first')).toBe(false);
    expect(sync.deviceRead('first')).toBe(false);
    expect(sync.deviceRead('second')).toBe(true);
    expect(sync.deviceRead('second')).toBe(false);
    expect(sync.deviceRead('')).toBe(false);
  });

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

  it('never echoes text back in the direction it came from', () => {
    const sync = clipboard.createClipboardSync();
    sync.deviceRead('start');
    sync.browserRead('start');
    expect(sync.deviceRead('from device')).toBe(true);
    sync.wrote('from device');
    expect(sync.browserRead('from device')).toBeNull();
    expect(sync.browserRead('from browser')).toEqual(set('from browser'));
    sync.sent('from browser');
    expect(sync.deviceRead('from browser')).toBe(false);
  });

  it('does not send the older browser text over the device text when the browser refused the write', () => {
    const sync = clipboard.createClipboardSync();
    sync.deviceRead('start');
    sync.browserRead('old browser text');
    expect(sync.deviceRead('newer device text')).toBe(true);
    expect(sync.browserRead('old browser text')).toBeNull();
  });

  it('shows the byte-limit note once for a text that is too long, and sends nothing', () => {
    const sync = clipboard.createClipboardSync();
    sync.browserRead('start');
    const long = 'a'.repeat(MAX_CLIPBOARD_BYTES + 1);
    expect(sync.browserRead(long)).toEqual({ note: expect.any(String) });
    expect(sync.browserRead(long)).toBeNull();
  });

  it('polls every two seconds, doubles after each failure up to thirty, and recovers on a success', () => {
    expect(clipboard.nextPollDelay(2000, true)).toBe(2000);
    expect(clipboard.nextPollDelay(2000, false)).toBe(4000);
    expect(clipboard.nextPollDelay(16000, false)).toBe(30000);
    expect(clipboard.nextPollDelay(30000, false)).toBe(30000);
    expect(clipboard.nextPollDelay(30000, true)).toBe(2000);
  });
});
