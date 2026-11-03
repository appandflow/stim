const GIB = 1024 ** 3;

export function derivedDeviceCap(ramBytes) {
  return Math.max(2, Math.floor((ramBytes / GIB - 4) / 1.5));
}

export function maxOf(rows, column) {
  let best = null;
  for (const row of rows) {
    const value = row[column];
    if (typeof value === 'number' && (best === null || value > best)) best = value;
  }
  return best;
}

export function minOf(rows, column) {
  let best = null;
  for (const row of rows) {
    const value = row[column];
    if (typeof value === 'number' && (best === null || value < best)) best = value;
  }
  return best;
}

export function longestStreak(rows, predicate, intervalSec) {
  let best = { ms: 0, samples: 0, startEpoch: null, endEpoch: null };
  let start = null;
  let count = 0;
  const close = (last) => {
    if (start === null) return;
    const ms = (last.epoch - start.epoch + intervalSec) * 1000;
    if (ms > best.ms) best = { ms, samples: count, startEpoch: start.epoch, endEpoch: last.epoch };
    start = null;
    count = 0;
  };
  let previous = null;
  for (const row of rows) {
    if (predicate(row)) {
      if (start === null) start = row;
      count += 1;
    } else close(previous);
    previous = row;
  }
  if (start !== null) close(previous);
  return best;
}

export function bucketRows(rows, bucketSec, columns) {
  if (!rows.length) return [];
  const origin = rows[0].epoch;
  const buckets = new Map();
  for (const row of rows) {
    const index = Math.floor((row.epoch - origin) / bucketSec);
    if (!buckets.has(index)) buckets.set(index, { offsetSec: index * bucketSec, stage: row.stage, rows: [] });
    buckets.get(index).rows.push(row);
  }
  return [...buckets.values()].map((bucket) => {
    const out = { offsetSec: bucket.offsetSec, stage: bucket.stage, samples: bucket.rows.length };
    for (const [column, how] of Object.entries(columns)) {
      out[column] = how === 'min' ? minOf(bucket.rows, column) : maxOf(bucket.rows, column);
    }
    return out;
  });
}

export function pagesToMb(pages, pageBytes) {
  return typeof pages === 'number' && pageBytes ? Math.round((pages * pageBytes) / 1048576) : null;
}
