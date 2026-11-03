import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Entry {
  id: string;
  name: string;
  color: number;
  kind?: 'viewer' | 'host' | 'agent';
  viewOnly?: boolean;
  touching?: boolean;
  self?: boolean;
}
interface Row {
  id: string;
  name: string;
  self: boolean;
  role: string;
  initial: string;
}
interface People {
  peopleRows: (entries: Entry[], shareControl: boolean) => Row[];
  peopleCount: (count: number) => string;
}

const people: People = runInNewContext(
  `${readFileSync(new URL('../share-viewer/people.js', import.meta.url), 'utf8')}\nglobalThis.stimPeople`,
);

const entry = (id: string, name: string, rest: Partial<Entry> = {}): Entry => ({ id, name, color: 2, ...rest });

describe('the share viewer People list', () => {
  it("lists the viewer's own row first and tells each role apart", () => {
    const rows = people.peopleRows(
      [
        entry('a', 'Ann'),
        entry('b', 'Bea', { viewOnly: true }),
        entry('c', 'Cy', { self: true }),
        entry('d', 'Dee', { touching: true }),
        entry('h', 'Host', { kind: 'host' }),
        entry('g', 'Agent - tap', { kind: 'agent' }),
      ],
      true,
    );
    expect(rows.map((row) => [row.name, row.role, row.self])).toEqual([
      ['Cy', 'can control', true],
      ['Ann', 'can control', false],
      ['Bea', 'view only', false],
      ['Dee', 'controlling', false],
      ['Host', 'controlling', false],
      ['Agent - tap', 'controlling', false],
    ]);
  });

  it('makes everyone view only on a share without control, whatever they last touched', () => {
    const rows = people.peopleRows([entry('a', 'Ann', { self: true }), entry('b', 'Bea', { touching: true })], false);
    expect(rows.map((row) => row.role)).toEqual(['view only', 'view only']);
  });

  it('takes the first whole character as the initial, and a question mark for an empty name', () => {
    const rows = people.peopleRows([entry('a', '\u{1d49c}lice'), entry('b', ''), entry('c', 'zed')], true);
    expect(rows.map((row) => row.initial)).toEqual(['\u{1d49c}', '?', 'Z']);
  });

  it('counts people, singular for one', () => {
    expect([1, 3].map((count) => people.peopleCount(count))).toEqual(['1 person', '3 people']);
  });
});
