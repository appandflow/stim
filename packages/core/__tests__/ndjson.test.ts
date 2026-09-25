import { LEVELS, levelRank, parseNdjsonLine, parseNdjsonText, SOURCES } from '../state/ndjson.ts';

describe('parseNdjsonLine', () => {
  test('parses a Contract-1 record', () => {
    const r = parseNdjsonLine('{"ts":1,"src":"metro","level":"info","msg":"hi"}');
    expect(r).toEqual({ ts: 1, src: 'metro', level: 'info', msg: 'hi' });
  });

  test('tolerates surrounding whitespace and carriage returns', () => {
    const r = parseNdjsonLine('  {"ts":2,"src":"client","level":"warn","msg":"x"}\r');
    expect(r!.msg).toBe('x');
  });

  test('returns null for a blank line', () => {
    expect(parseNdjsonLine('')).toBe(null);
    expect(parseNdjsonLine('   ')).toBe(null);
  });

  test('returns null for a truncated or corrupt line', () => {
    expect(parseNdjsonLine('{"ts":1,"src":"met')).toBe(null);
    expect(parseNdjsonLine('not json at all')).toBe(null);
  });

  test('returns null for valid JSON that is not an object', () => {
    expect(parseNdjsonLine('42')).toBe(null);
    expect(parseNdjsonLine('"str"')).toBe(null);
    expect(parseNdjsonLine('[1,2]')).toBe(null);
    expect(parseNdjsonLine('null')).toBe(null);
  });

  test('returns null for a non-string input', () => {
    expect(parseNdjsonLine(undefined)).toBe(null);
    expect(parseNdjsonLine(null)).toBe(null);
  });
});

describe('parseNdjsonText', () => {
  test('parses every line and skips the corrupt ones', () => {
    const text = '{"ts":1,"msg":"a"}\ngarbage\n{"ts":2,"msg":"b"}\n';
    expect(parseNdjsonText(text).map((r) => r.msg)).toEqual(['a', 'b']);
  });

  test('returns [] for empty or missing text', () => {
    expect(parseNdjsonText('')).toEqual([]);
    expect(parseNdjsonText(undefined)).toEqual([]);
  });

  test('drops a trailing partial line rather than failing the whole read', () => {
    const text = '{"ts":1,"msg":"a"}\n{"ts":2,"ms';
    expect(parseNdjsonText(text).map((r) => r.msg)).toEqual(['a']);
  });
});

describe('levels', () => {
  test('LEVELS is the Contract-1 order, lowest first', () => {
    expect(LEVELS).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
  });

  test('levelRank orders them and puts an unknown level at the bottom', () => {
    expect(levelRank('fatal') > levelRank('error')).toBeTruthy();
    expect(levelRank('error') > levelRank('warn')).toBeTruthy();
    expect(levelRank('warn') > levelRank('info')).toBeTruthy();
    expect(levelRank('info') > levelRank('debug')).toBeTruthy();
    expect(levelRank('nonsense')).toBe(0);
    expect(levelRank(undefined)).toBe(0);
  });
});

describe('sources', () => {
  test('SOURCES is the Contract-1 set', () => {
    expect(SOURCES).toEqual(['metro', 'client', 'device', 'build', 'agent']);
  });
});
