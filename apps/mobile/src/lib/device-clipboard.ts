import { MAX_CLIPBOARD_BYTES } from '@stim-cli/core/protocol';

import type { DevicePlatform } from '@/protocol/types';

/**
 * Whether the device viewer offers the clipboard actions: a control session is on and the device is an iOS simulator,
 * an Android emulator or an Android phone. A web page, a native macOS app and a physical iPhone refuse the methods.
 */
export function clipboardAvailable({
  platform,
  physical,
  controlling,
}: {
  platform: DevicePlatform;
  physical: boolean;
  controlling: boolean;
}): boolean {
  if (!controlling) return false;
  return platform === 'android' || (platform === 'ios' && !physical);
}

/** The UTF-8 size of `text` in bytes, as the server counts it. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const CLIPBOARD_LIMIT_KIB = MAX_CLIPBOARD_BYTES / 1024;

export type PasteOutcome = 'typed' | 'pasted' | 'empty' | 'too-large';
export type CopyOutcome = 'copied' | 'empty';

/**
 * Reads the phone clipboard and sets the device clipboard with `paste`. Nothing is sent for an empty clipboard or
 * for text over the 8 KiB the server takes. `typed` means an iOS simulator typed the text into the focused field, so
 * iOS showed no paste prompt; any other outcome of a paste on iOS can leave a paste suggestion to tap.
 */
export async function pasteFromPhone(io: {
  read: () => Promise<string>;
  set: (text: string, paste: boolean) => Promise<{ typed?: true } | void>;
}): Promise<PasteOutcome> {
  const text = await io.read();
  if (text === '') return 'empty';
  if (utf8Bytes(text) > MAX_CLIPBOARD_BYTES) return 'too-large';
  const result = await io.set(text, true);
  return result?.typed ? 'typed' : 'pasted';
}

/** Reads the device clipboard and writes it to the phone clipboard; an empty device clipboard leaves the phone's alone. */
export async function copyDeviceClipboard(io: {
  get: () => Promise<string>;
  write: (text: string) => Promise<void>;
}): Promise<CopyOutcome> {
  const text = await io.get();
  if (text === '') return 'empty';
  await io.write(text);
  return 'copied';
}
