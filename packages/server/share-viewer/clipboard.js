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

const POLL_MS = 2000;
const POLL_MAX_MS = 30000;

function nextPollDelay(current, ok) {
  return ok ? POLL_MS : Math.min(current * 2, POLL_MAX_MS);
}

function createClipboardSync() {
  let device = null;
  let browser = null;
  return {
    deviceRead(text) {
      const first = device === null;
      if (typeof text !== 'string' || text === device) return false;
      device = text;
      return !(first || text === '' || text === browser);
    },
    wrote(text) {
      browser = text;
    },
    browserRead(text) {
      if (typeof text !== 'string' || text === browser) return null;
      if (browser === null || text === '' || text === device) {
        browser = text;
        return null;
      }
      const request = pasteRequest(text);
      if (request && request.message) return { message: { type: 'clipboard-set', text } };
      browser = text;
      return request;
    },
    sent(text) {
      browser = text;
      device = text;
    },
  };
}

globalThis.stimClipboard = { pasteRequest, writeClipboard, nextPollDelay, createClipboardSync };
