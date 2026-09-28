import { parseSectionState, sectionRows } from '@/lib/sections';

const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('sectionRows', () => {
  it('shows every row with no toggle up to the cap', () => {
    expect(sectionRows(rows(10), false)).toEqual({ shown: rows(10), toggle: null });
  });

  it('caps a longer section at the first 10 rows and offers them all', () => {
    expect(sectionRows(rows(23), false)).toEqual({ shown: rows(10), toggle: 'Show all 23' });
    expect(sectionRows(rows(23), true)).toEqual({ shown: rows(23), toggle: 'Show fewer' });
  });
});

describe('parseSectionState', () => {
  it('reads a saved state and falls back to expanded and capped', () => {
    expect(parseSectionState('{"collapsed":true,"showAll":true}')).toEqual({ collapsed: true, showAll: true });
    expect(parseSectionState(undefined)).toEqual({ collapsed: false, showAll: false });
    expect(parseSectionState('not json')).toEqual({ collapsed: false, showAll: false });
    expect(parseSectionState('{"collapsed":"yes"}')).toEqual({ collapsed: false, showAll: false });
  });
});
