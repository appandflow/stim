import { asciiText, framePoint, keyboardDelta, otherDriver } from '@/lib/device-control';

describe('framePoint', () => {
  const frame = { width: 600, height: 1300 };

  it('maps a touch through the letterbox of a picture narrower than its view', () => {
    const box = { width: 500, height: 1300 / 1.5 };
    expect(framePoint(250, 1300 / 3, box, frame, false)).toEqual({ x: 0.5, y: 0.5 });
    expect(framePoint(10, 100, box, frame, false)).toBeNull();
  });

  it('pins a drag that leaves the picture to its edge', () => {
    const box = { width: 300, height: 650 };
    expect(framePoint(-40, 700, box, frame, true)).toEqual({ x: 0, y: 1 });
  });

  it('ignores touches before the view or the frame has a size', () => {
    expect(framePoint(10, 10, { width: 0, height: 0 }, frame, true)).toBeNull();
  });
});

describe('asciiText', () => {
  it('keeps printable ASCII and newlines, converts smart punctuation, and drops the rest', () => {
    expect(asciiText('It’s “ok”…\n')).toBe('It\'s "ok"...\n');
    expect(asciiText('café \u{1F600}')).toBe('caf ');
  });
});

describe('otherDriver', () => {
  const since = '2026-09-25T12:00:00.000Z';

  it("names an agent that drives the device, but not this phone's own lease", () => {
    const lock = { state: 'driven' as const, driver: { tool: 'stim device lock', pid: null, since }, basis: [] };
    expect(otherDriver(lock, since)).toBeNull();
    expect(otherDriver(lock, null)).toBe('stim device lock');
    expect(otherDriver({ state: 'driven', driver: { tool: 'agent-device', pid: 4, since }, basis: [] }, since)).toBe(
      'agent-device',
    );
    expect(otherDriver({ state: 'active', basis: [] }, null)).toBeNull();
  });
});

describe('keyboardDelta', () => {
  it('types what the field gained and deletes what it lost, including an autocorrected word', () => {
    expect(keyboardDelta('He', 'Hel')).toBe('l');
    expect(keyboardDelta('Hel', 'He')).toBe('\b');
    expect(keyboardDelta('teh', 'the ')).toBe('\b\bhe ');
    expect(keyboardDelta('', '')).toBe('');
    expect(keyboardDelta('caf\u00E9', 'caf')).toBe('');
    expect(keyboardDelta('ok\u2026', 'ok')).toBe('\b\b\b');
  });
});
