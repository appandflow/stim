import { readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2] ?? 'runs';
const SKIP = 3000,
  SPAN = 24000;
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const rows = [];
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.ndjson') && !f.startsWith('none'))
  .sort()) {
  const batches = readFileSync(`${dir}/${file}`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const events = batches.flatMap((b) => b.progress);
  if (events.length < 10) continue;
  const t0 = events[0].t + SKIP;
  const use = events.filter((e) => e.t >= t0 && e.t <= t0 + SPAN);
  if (use.length < 2) {
    rows.push({ run: file.replace('.ndjson', ''), fps: 0, note: `only ${events.length} frames` });
    continue;
  }
  const dur = (use.at(-1).t - use[0].t) / 1000;
  const frames = use.slice(1).reduce((s, e) => s + e.f, 0);
  const lat = use.flatMap((e) => Array(e.f).fill(e.l)).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < use.length; i++) gaps.push(use[i].t - use[i - 1].t);
  const stalls = gaps.filter((g) => g > 100);
  const last = batches.at(-1);
  rows.push({
    run: file.replace('.ndjson', ''),
    s: +dur.toFixed(1),
    fps: +(frames / dur).toFixed(1),
    p50: Math.round(pct(lat, 0.5)),
    p95: Math.round(pct(lat, 0.95)),
    p99: Math.round(pct(lat, 0.99)),
    gap100: stalls.length,
    stallMs: stalls.reduce((a, b) => a + b, 0),
    maxGap: Math.max(...gaps),
    rtcGaps: last.transport === 'rtc' ? last.rtc.gaps : '',
    kreq: last.transport === 'rtc' ? last.rtc.keyframeRequests : '',
    srvDropped: last.transport === 'rtc' ? last.rtc.server?.dropped : '',
  });
}
console.table(rows);
