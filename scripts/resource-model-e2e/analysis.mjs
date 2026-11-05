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
  const close = (last, next) => {
    if (start === null) return;
    const ms = ((next ? next.epoch : last.epoch + intervalSec) - start.epoch) * 1000;
    if (ms > best.ms) best = { ms, samples: count, startEpoch: start.epoch, endEpoch: last.epoch };
    start = null;
    count = 0;
  };
  let previous = null;
  for (const row of rows) {
    if (predicate(row)) {
      if (start === null) start = row;
      count += 1;
    } else close(previous, row);
    previous = row;
  }
  if (start !== null) close(previous, null);
  return best;
}

export function secondsWhere(rows, predicate, intervalSec) {
  let total = 0;
  rows.forEach((row, index) => {
    if (predicate(row)) total += (rows[index + 1]?.epoch ?? row.epoch + intervalSec) - row.epoch;
  });
  return total;
}

const GAP_FACTOR = 3;

export function sampleQuality(rows, nominalSec) {
  const gaps = [];
  const suspectLoad = [];
  const spacing = [];
  for (let i = 1; i < rows.length; i++) {
    const [prev, cur] = [rows[i - 1], rows[i]];
    const dt = cur.epoch - prev.epoch;
    spacing.push(dt);
    if (dt > GAP_FACTOR * nominalSec)
      gaps.push({ fromEpoch: prev.epoch, toEpoch: cur.epoch, sec: dt, stage: prev.stage });
    if (
      typeof prev.load1 === 'number' &&
      typeof cur.load1 === 'number' &&
      dt <= 30 &&
      cur.load1 < prev.load1 * Math.exp(-dt / 60) * 0.5
    ) {
      suspectLoad.push({ epoch: cur.epoch, previous: prev.load1, reading: cur.load1, sec: dt });
    }
  }
  const sorted = spacing.toSorted((a, b) => a - b);
  return {
    rows: rows.length,
    spanSec: rows.length > 1 ? rows.at(-1).epoch - rows[0].epoch : 0,
    medianSec: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    longestSec: sorted.length ? sorted.at(-1) : null,
    gaps,
    suspectLoad,
  };
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
