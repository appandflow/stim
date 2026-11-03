'use strict';

/** The most UTF-8 bytes of text one paste sends; MAX_CLIPBOARD_BYTES in packages/core/protocol.ts. */
const MAX_PASTE_BYTES = 8192;

/**
 * What the viewer does with the text of a browser `paste` event: the message that pastes it into the device, a note
 * to show when it is too long to send, or null when there is nothing to paste.
 */
function pasteRequest(text) {
  if (typeof text !== 'string' || text === '') return null;
  if (new TextEncoder().encode(text).length > MAX_PASTE_BYTES) {
    return { note: 'That text is too long to paste: the limit is 8 KiB.' };
  }
  return { message: { type: 'clipboard-set', text, paste: true } };
}

/**
 * Puts the device clipboard text that `text` (a promise) will resolve to on the browser's clipboard. It starts inside
 * the click that asked for it: a ClipboardItem takes the promise itself, which keeps the click's permission while the
 * device answers; without ClipboardItem it waits for the text and falls back to writeText.
 */
function writeClipboard(clipboard, ClipboardItemClass, BlobClass, text) {
  if (typeof ClipboardItemClass === 'function' && typeof clipboard.write === 'function') {
    return clipboard.write([
      new ClipboardItemClass({ 'text/plain': text.then((value) => new BlobClass([value], { type: 'text/plain' })) }),
    ]);
  }
  return text.then((value) => clipboard.writeText(value));
}

globalThis.stimClipboard = { pasteRequest, writeClipboard };
