'use strict';

/**
 * Carries the share's H.264 access units over a WebRTC data channel and shows transport stats. The page
 * asks for it with ?transport=webrtc (remembered in a cookie) and ?stats shows the panel on either transport.
 */
(function () {
  const query = new URLSearchParams(location.search);
  const cookieMatch = /(?:^|; )stim_transport=(webrtc|ws)/.exec(document.cookie);
  const preferred = query.get('transport') || (cookieMatch && cookieMatch[1]) || 'ws';
  const offered = document.body.dataset.webrtc === 'true';
  const wanted = offered && preferred === 'webrtc' && typeof RTCPeerConnection === 'function';
  const visible = wanted || query.has('stats');
  const basePath = location.pathname.replace(/[^/]*$/, '');
  const iceServers = (document.body.dataset.stun || '')
    .split(',')
    .filter(Boolean)
    .map((urls) => ({ urls }));
  const GATHER_MS = 2500;
  const CONNECT_MS = 12000;
  const WINDOW_MS = 1000;

  const state = {
    active: 'ws',
    note: '',
    drawn: [],
    bytes: [],
    latency: [],
    gaps: 0,
    late: 0,
    keyframes: 0,
    serverDropped: 0,
    serverRtt: null,
    queued: 0,
    serverPair: null,
    pair: null,
    pcRtt: null,
    ctlRtt: null,
    wsRtt: null,
    offsets: { rtc: null, ws: null },
    samples: { rtc: [], ws: [] },
  };

  let pc = null;
  let video = null;
  let ctl = null;
  let connectTimer = null;
  let pingTimer = null;
  let statsTimer = null;
  let handlers = null;
  let box = null;
  let lines = null;

  function setTransportCookie(value) {
    document.cookie = 'stim_transport=' + value + '; Path=' + basePath + '; Max-Age=86400; SameSite=Strict; Secure';
  }

  function trim(list, now) {
    while (list.length && now - list[0][0] > WINDOW_MS) list.shift();
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  function sample(kind, t0, serverTime) {
    const t1 = Date.now();
    const rtt = t1 - t0;
    const list = state.samples[kind];
    list.push({ rtt, offset: serverTime - (t0 + rtt / 2) });
    if (list.length > 10) list.shift();
    const best = list.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    state.offsets[kind] = best.offset;
    if (kind === 'rtc') state.ctlRtt = rtt;
    else state.wsRtt = rtt;
  }

  function candidate(report) {
    if (!report) return '?';
    const host = report.address || report.ip || '?';
    return report.candidateType + ' ' + (report.protocol || '') + ' ' + host + ':' + report.port;
  }

  async function readPair() {
    if (!pc) return;
    const reports = await pc.getStats();
    let selected = null;
    reports.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId)
        selected = reports.get(report.selectedCandidatePairId);
    });
    if (!selected) {
      reports.forEach((report) => {
        if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') selected = report;
      });
    }
    if (!selected) return;
    const local = reports.get(selected.localCandidateId);
    const remote = reports.get(selected.remoteCandidateId);
    state.pair = {
      local: candidate(local),
      remote: candidate(remote),
      type: local && remote ? local.candidateType + '/' + remote.candidateType : '?',
    };
    state.pcRtt =
      typeof selected.currentRoundTripTime === 'number' ? Math.round(selected.currentRoundTripTime * 1000) : null;
  }

  function render() {
    if (!lines) return;
    const now = performance.now();
    trim(state.drawn, now);
    trim(state.bytes, now);
    const fps = state.drawn.length;
    const bits = state.bytes.reduce((total, entry) => total + entry[1], 0) * 8;
    const latencies = state.latency.slice(-120).map((entry) => entry[1]);
    const offsetKind = state.active === 'webrtc' ? 'rtc' : 'ws';
    const rows = [
      ['transport', state.active === 'webrtc' ? 'WebRTC data channel' : 'WebSocket' + (wanted ? ' (fallback)' : '')],
      [
        'path',
        state.active === 'webrtc' && state.pair
          ? state.pair.type + ' ' + state.pair.remote
          : state.active === 'webrtc'
            ? 'connecting'
            : 'TCP via the share URL',
      ],
      [
        'rtt',
        (state.active === 'webrtc' ? [state.pcRtt, state.ctlRtt] : [state.wsRtt])
          .filter((value) => value !== null)
          .join(' / ') + ' ms',
      ],
      ['fps', String(fps)],
      ['bitrate', (bits / 1e6).toFixed(2) + ' Mbps'],
      [
        'latency',
        latencies.length && state.offsets[offsetKind] !== null
          ? 'p50 ' + Math.round(percentile(latencies, 0.5)) + ' p95 ' + Math.round(percentile(latencies, 0.95)) + ' ms'
          : 'n/a',
      ],
      ['loss', 'gaps ' + state.gaps + ' late ' + state.late + ' keyframe asks ' + state.keyframes],
    ];
    if (state.active === 'webrtc')
      rows.push(['sender', 'queued ' + state.queued + ' B dropped ' + state.serverDropped]);
    if (state.note) rows.push(['note', state.note]);
    lines.textContent = rows.map((row) => row[0].padEnd(10) + row[1]).join('\n');
  }

  function buildPanel() {
    box = document.createElement('div');
    box.className = 'rtc-stats';
    lines = document.createElement('pre');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = wanted ? 'Use WebSocket' : 'Use WebRTC';
    toggle.addEventListener('click', () => {
      setTransportCookie(wanted ? 'ws' : 'webrtc');
      const next = new URL(location.href);
      next.searchParams.delete('transport');
      location.replace(next.toString());
    });
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.textContent = 'Hide';
    hide.addEventListener('click', () => box.remove());
    if (offered) box.append(lines, toggle, hide);
    else box.append(lines, hide);
    document.body.append(box);
    setInterval(render, 500);
  }

  function ping() {
    if (ctl && ctl.readyState === 'open') ctl.send(JSON.stringify({ t: 'ping', c: Date.now() }));
  }

  function failed(reason) {
    if (!pc) return;
    stop();
    state.active = 'ws';
    state.note = reason;
    if (handlers) handlers.failed(reason);
  }

  function stop() {
    clearTimeout(connectTimer);
    clearInterval(pingTimer);
    clearInterval(statsTimer);
    if (pc) {
      pc.close();
    }
    pc = video = ctl = null;
    if (state.active === 'webrtc') state.active = 'ws';
  }

  async function start(options) {
    handlers = options;
    stop();
    state.active = 'ws';
    state.note = '';
    state.pair = null;
    state.samples.rtc = [];
    state.offsets.rtc = null;
    const peer = new RTCPeerConnection({ iceServers });
    pc = peer;
    const lifetime = Number(query.get('ttl'));
    video = peer.createDataChannel(
      'video',
      lifetime > 0 ? { ordered: false, maxPacketLifeTime: lifetime } : { ordered: false, maxRetransmits: 0 },
    );
    video.binaryType = 'arraybuffer';
    video.addEventListener('message', (event) => handlers.video(event.data));
    ctl = peer.createDataChannel('ctl');
    ctl.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.t === 'pong') sample('rtc', message.c, message.s);
      else if (message.t === 'stats') {
        state.serverDropped = message.dropped;
        state.queued = message.queued;
        state.serverRtt = message.rtt;
        state.serverPair = message.pair;
      }
    });
    video.addEventListener('open', () => {
      if (peer !== pc) return;
      clearTimeout(connectTimer);
      state.active = 'webrtc';
      handlers.opened();
    });
    ctl.addEventListener('open', () => {
      ping();
      pingTimer = setInterval(ping, 2000);
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer !== pc) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed')
        failed('WebRTC ' + peer.connectionState);
      else if (peer.connectionState === 'disconnected')
        setTimeout(() => peer === pc && peer.connectionState === 'disconnected' && failed('WebRTC disconnected'), 3000);
    });
    statsTimer = setInterval(() => void readPair().catch(() => {}), 1000);
    connectTimer = setTimeout(() => peer === pc && failed('WebRTC did not connect'), CONNECT_MS);
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const done = () => peer.iceGatheringState === 'complete' && resolve();
        peer.addEventListener('icegatheringstatechange', done);
        setTimeout(resolve, GATHER_MS);
      });
    }
    if (peer !== pc) return;
    handlers.send({ type: 'webrtc-offer', sdp: peer.localDescription.sdp });
  }

  async function answer(sdp) {
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
  }

  window.stimRtc = {
    wanted,
    visible,
    start,
    answer,
    stop,
    failed,
    /** Asks for a keyframe over the data channel; false when it is not open. */
    keyframe() {
      if (!ctl || ctl.readyState !== 'open') return false;
      state.keyframes++;
      ctl.send(JSON.stringify({ t: 'keyframe' }));
      return true;
    },
    countKeyframe() {
      state.keyframes++;
    },
    clock(message) {
      sample('ws', message.c, message.s);
    },
    received(bytes) {
      if (!visible) return;
      state.bytes.push([performance.now(), bytes]);
    },
    drawn(capturedAt) {
      if (!visible) return;
      const now = performance.now();
      state.drawn.push([now]);
      const offset = state.offsets[state.active === 'webrtc' ? 'rtc' : 'ws'];
      if (offset !== null && capturedAt) {
        state.latency.push([now, Date.now() + offset - capturedAt]);
        if (state.latency.length > 600) state.latency.splice(0, 300);
      }
    },
    gap() {
      state.gaps++;
    },
    late() {
      state.late++;
    },
    snapshot() {
      return {
        queued: state.queued,
        dropped: state.serverDropped,
        ctlRtt: state.ctlRtt,
        pcRtt: state.pcRtt,
        wsRtt: state.wsRtt,
        gaps: state.gaps,
      };
    },
    get active() {
      return state.active;
    },
  };

  if (visible) buildPanel();
})();
