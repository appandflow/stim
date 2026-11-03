'use strict';

/** The most UTF-8 bytes of text one paste sends; MAX_CLIPBOARD_BYTES in packages/core/protocol.ts. */
const MAX_PASTE_BYTES = 8192;

function pasteRequest(text) {
  if (typeof text !== 'string' || text === '') return null;
  if (new TextEncoder().encode(text).length > MAX_PASTE_BYTES) {
    return { note: 'That text is too long to paste: the limit is 8 KiB.' };
  }
  return { message: { type: 'clipboard-set', text, paste: true } };
}

/**
 * Browsers allow a clipboard write only inside the click's user activation, which a device round trip can outlast, so a
 * ClipboardItem takes the text as a promise; without ClipboardItem it waits for the text and uses writeText.
 */
function writeClipboard(clipboard, ClipboardItemClass, BlobClass, text) {
  if (typeof ClipboardItemClass === 'function' && typeof clipboard.write === 'function') {
    return clipboard.write([
      new ClipboardItemClass({ 'text/plain': text.then((value) => new BlobClass([value], { type: 'text/plain' })) }),
    ]);
  }
  return text.then((value) => clipboard.writeText(value));
}

/** The device clipboard is polled this often while sync is on, and no slower than the cap after repeated failures. */
const POLL_MS = 2000;
const POLL_MAX_MS = 30000;

function nextPollDelay(current, ok) {
  return ok ? POLL_MS : Math.min(current * 2, POLL_MAX_MS);
}

/**
 * What to do with each text the page reads, so the two clipboards never echo: the last text seen or sent in each
 * direction is remembered, and the first read in each direction only records.
 */
function createClipboardSync() {
  let device = null;
  let browser = null;
  return {
    /** True when the device text is new and should be written to the browser clipboard. */
    deviceRead(text) {
      const first = device === null;
      if (typeof text !== 'string' || text === device) return false;
      device = text;
      if (first || text === '' || text === browser) return false;
      browser = text;
      return true;
    },
    /** The `clipboard-set` message or note for a browser clipboard text, or null when there is nothing to send. */
    browserRead(text) {
      if (typeof text !== 'string' || text === browser) return null;
      const first = browser === null;
      browser = text;
      if (first || text === '' || text === device) return null;
      const request = pasteRequest(text);
      if (request && request.message) {
        device = text;
        return { message: { type: 'clipboard-set', text } };
      }
      return request;
    },
  };
}

globalThis.stimClipboard = { pasteRequest, writeClipboard, nextPollDelay, createClipboardSync };
