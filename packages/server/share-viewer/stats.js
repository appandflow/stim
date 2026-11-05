'use strict';

/** The ?stats panel: what this page measures of the video it takes over the share socket. */
(function () {
  const visible = new URLSearchParams(location.search).has('stats');
  const WINDOW_MS = 1000;
  const MAX_SAMPLES = 10;
  const MAX_LATENCIES = 600;
  const drawn = [];
  const bytes = [];
  const latency = [];
  const samples = [];
  let keyframes = 0;
  let rtt = null;
  let offset = null;
  let lines = null;

  function trim(list, now) {
    while (list.length && now - list[0][0] > WINDOW_MS) list.shift();
  }

  function percentile(values, p) {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  function render() {
    const now = performance.now();
    trim(drawn, now);
    trim(bytes, now);
    const bits = bytes.reduce((total, entry) => total + entry[1], 0) * 8;
    const delays = latency.slice(-120).map((entry) => entry[1]);
    const rows = [
      ['transport', 'WebSocket'],
      ['rtt', rtt === null ? 'n/a' : rtt + ' ms'],
      ['fps', String(drawn.length)],
      ['bitrate', (bits / 1e6).toFixed(2) + ' Mbps'],
      [
        'latency',
        delays.length && offset !== null
          ? 'p50 ' + Math.round(percentile(delays, 0.5)) + ' p95 ' + Math.round(percentile(delays, 0.95)) + ' ms'
          : 'n/a',
      ],
      ['keyframes', 'asked ' + keyframes],
    ];
    lines.textContent = rows.map((row) => row[0].padEnd(10) + row[1]).join('\n');
  }

  function buildPanel() {
    const box = document.createElement('div');
    box.className = 'stats-panel';
    lines = document.createElement('pre');
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.textContent = 'Hide';
    hide.addEventListener('click', () => box.remove());
    box.append(lines, hide);
    document.body.append(box);
    setInterval(render, 500);
  }

  window.stimStats = {
    visible,
    /** Handles the server's reply to a `clock` ping: the round trip, and the offset between the two clocks. */
    clock(message) {
      const roundTrip = Date.now() - message.c;
      samples.push({ rtt: roundTrip, offset: message.s - (message.c + roundTrip / 2) });
      if (samples.length > MAX_SAMPLES) samples.shift();
      rtt = roundTrip;
      offset = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
    },
    received(length) {
      if (visible) bytes.push([performance.now(), length]);
    },
    drawn(capturedAt) {
      if (!visible) return;
      const now = performance.now();
      drawn.push([now]);
      if (offset !== null && capturedAt) {
        latency.push([now, Date.now() + offset - capturedAt]);
        if (latency.length > MAX_LATENCIES) latency.splice(0, MAX_LATENCIES / 2);
      }
    },
    keyframe() {
      keyframes++;
    },
  };

  if (visible) buildPanel();
})();
