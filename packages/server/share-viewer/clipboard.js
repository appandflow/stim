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

function createClipboardSync() {
  let browser = null;
  return {
    browserRead(text) {
      if (typeof text !== 'string' || text === browser) return null;
      if (browser === null || text === '') {
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
    },
  };
}

globalThis.stimClipboard = { pasteRequest, createClipboardSync };
