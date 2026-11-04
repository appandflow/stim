import { clipboardAvailable, copyDeviceClipboard, pasteFromPhone, utf8Bytes } from './device-clipboard';

const FEATURES = ['device-clipboard'];
const E_ACUTE = String.fromCodePoint(0xe9);
const EURO = String.fromCodePoint(0x20ac);
const EMOJI = String.fromCodePoint(0x1f600);

describe('clipboardAvailable', () => {
  test('needs a control session and the server feature', () => {
    const ios: Parameters<typeof clipboardAvailable>[0] = { platform: 'ios', physical: false, controlling: true };
    expect(clipboardAvailable(ios, FEATURES)).toBe(true);
    expect(clipboardAvailable({ ...ios, controlling: false }, FEATURES)).toBe(false);
    expect(clipboardAvailable(ios, ['physical-ios'])).toBe(false);
    expect(clipboardAvailable(ios, null)).toBe(false);
  });

  test('covers simulators, emulators and Android phones, not a web page, a Mac app or an iPhone', () => {
    expect(clipboardAvailable({ controlling: true, platform: 'android', physical: false }, FEATURES)).toBe(true);
    expect(clipboardAvailable({ controlling: true, platform: 'android', physical: true }, FEATURES)).toBe(true);
    expect(clipboardAvailable({ controlling: true, platform: 'ios', physical: true }, FEATURES)).toBe(false);
    expect(clipboardAvailable({ controlling: true, platform: 'web', physical: false }, FEATURES)).toBe(false);
    expect(clipboardAvailable({ controlling: true, platform: 'macos', physical: false }, FEATURES)).toBe(false);
  });
});

test('utf8Bytes counts bytes, not characters', () => {
  expect(utf8Bytes('a')).toBe(1);
  expect(utf8Bytes(E_ACUTE)).toBe(2);
  expect(utf8Bytes(EURO)).toBe(3);
  expect(utf8Bytes(EMOJI)).toBe(4);
});

describe('pasteFromPhone', () => {
  const run = (text: string) => {
    const set = jest.fn().mockResolvedValue(undefined);
    return { set, outcome: pasteFromPhone({ read: () => Promise.resolve(text), set }) };
  };

  test('sets the text with paste', async () => {
    const text = `h${E_ACUTE}llo ${EMOJI}`;
    const { set, outcome } = run(text);
    await expect(outcome).resolves.toBe('pasted');
    expect(set).toHaveBeenCalledWith(text, true);
  });

  test('reports a paste the server typed into the field', async () => {
    const set = jest.fn().mockResolvedValue({ typed: true });
    await expect(pasteFromPhone({ read: () => Promise.resolve('typed text'), set })).resolves.toBe('typed');
  });

  test('takes exactly 8192 bytes', async () => {
    const { set, outcome } = run('a'.repeat(8192));
    await expect(outcome).resolves.toBe('pasted');
    expect(set).toHaveBeenCalledTimes(1);
  });

  test('sends nothing over 8192 bytes, counted in UTF-8 not characters', async () => {
    for (const text of ['a'.repeat(8193), E_ACUTE.repeat(4097)]) {
      const { set, outcome } = run(text);
      await expect(outcome).resolves.toBe('too-large');
      expect(set).not.toHaveBeenCalled();
    }
  });

  test('sends nothing for an empty clipboard', async () => {
    const { set, outcome } = run('');
    await expect(outcome).resolves.toBe('empty');
    expect(set).not.toHaveBeenCalled();
  });

  test('passes the server refusal on and does not report a paste', async () => {
    const set = jest.fn().mockRejectedValue(new Error('refused'));
    await expect(pasteFromPhone({ read: () => Promise.resolve('x'), set })).rejects.toThrow('refused');
  });
});

describe('copyDeviceClipboard', () => {
  test('writes the device text to the phone', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    await expect(copyDeviceClipboard({ get: () => Promise.resolve('from device'), write })).resolves.toBe('copied');
    expect(write).toHaveBeenCalledWith('from device');
  });

  test('leaves the phone clipboard alone when the device clipboard is empty', async () => {
    const write = jest.fn();
    await expect(copyDeviceClipboard({ get: () => Promise.resolve(''), write })).resolves.toBe('empty');
    expect(write).not.toHaveBeenCalled();
  });
});
