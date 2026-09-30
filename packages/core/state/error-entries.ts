import type { NdjsonRecord } from './ndjson.ts';

const BUNDLE_LINE_WINDOW_MS = 1000;
const BUNDLE_RESPONSE_WINDOW_MS = 2000;

interface Group {
  indexes: number[];
  lead: number;
}

function isError(record: NdjsonRecord): boolean {
  return record.level === 'error' || record.level === 'fatal';
}

function isExpoLine(record: NdjsonRecord): boolean {
  return record.src === 'metro' && record.raw === true && record.event === 'expo_stdout';
}

/**
 * The number of rows a log list shows for `records`, an error query's result in log order. Stim Desktop's
 * `LogEntryList` and the phone's `groupRecords` group the same way and replay the same vectors: in Expo's dev
 * server one failed bundle is a `Bundling failed` marker line, the error line and a failed bundle response,
 * which the apps list as one row, and every other record is its own row.
 */
export function countErrorEntries(records: readonly NdjsonRecord[]): number {
  const taken = new Set<number>();
  const groups: Group[] = [];

  for (let i = 0; i < records.length; i += 1) {
    if (taken.has(i)) continue;
    const record = records[i]!;
    taken.add(i);
    const group: Group = { indexes: [i], lead: i };
    groups.push(group);
    if (!(isExpoLine(record) && isError(record) && record.marker === true)) continue;
    const j = records.findIndex((next, at) => at > i && !taken.has(at) && isExpoLine(next));
    const next = j < 0 ? null : records[j]!;
    if (next && isError(next) && next.marker !== true && (next.ts ?? 0) - (record.ts ?? 0) <= BUNDLE_LINE_WINDOW_MS) {
      taken.add(j);
      group.indexes.push(j);
      group.lead = j;
    }
  }

  const failures = groups.filter((g) => {
    const first = records[g.indexes[0]!]!;
    return isExpoLine(first) && first.marker === true && isError(first);
  });
  const answered = new Set<Group>();
  let merged = 0;
  for (const response of groups.filter((g) => records[g.lead]!.event === 'bundle_response_failed')) {
    const { ts, platform } = records[response.lead]!;
    const distance = (g: Group) => Math.abs((records[g.indexes[0]!]!.ts ?? 0) - (ts ?? 0));
    const target = failures
      .filter(
        (g) =>
          !answered.has(g) &&
          distance(g) <= BUNDLE_RESPONSE_WINDOW_MS &&
          (typeof platform !== 'string' ||
            String(records[g.indexes[0]!]!.msg ?? '')
              .toLowerCase()
              .startsWith(`${platform.toLowerCase()} `)),
      )
      .toSorted((a, b) => distance(a) - distance(b))[0];
    if (!target) continue;
    answered.add(target);
    merged += 1;
  }
  return groups.length - merged;
}
