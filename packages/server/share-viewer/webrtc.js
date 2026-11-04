'use strict';

/**
 * Carries the share's H.264 access units over a WebRTC data channel when that works better than the share socket.
 * Every page starts on the socket; a data channel is opened in the background and takes over only after it delivers
 * a keyframe the decoder can start from, and gives the video back to the socket when it fails or loses too much.
 * ?transport=ws keeps a page on the socket (remembered in a cookie), ?transport=webrtc forces the channel, and ?stats
 * shows a panel on either transport.
 */
(function () {
  const policy = globalThis.stimRtcPolicy;
  const query = new URLSearchParams(location.search);
  const cookieMatch = /(?:^|; )stim_transport=(webrtc|ws)/.exec(document.cookie);
  const offered = document.body.dataset.webrtc === 'true';
  const mode = policy.wanted(
    offered,
    typeof RTCPeerConnection === 'function',
    query.get('transport'),
    cookieMatch && cookieMatch[1],
  );
  const wanted = mode !== 'off';
  const visible = query.has('stats') || mode === 'force';
  const basePath = location.pathname.replace(/[^/]*$/, '');
  const iceServers = (document.body.dataset.stun || '')
    .split(',')
    .filter(Boolean)
    .map((urls) => ({ urls }));
  const BEGIN_DELAY_MS = 1000;
  const GATHER_MS = 2500;
  const CONNECT_MS = 8000;
  const PROBE_MS = 6000;
  const PROBE_ASK_MS = 1000;
  const FIRST_DRAW_MS = 3000;
  const QUIET_MS = 4000;
  const DEFAULT_TTL_MS = 100;
  const WINDOW_MS = 1000;

  const state = {
    phase: 'idle',
    note: '',
    drawn: [],
    bytes: [],
    latency: [],
    gaps: 0,
    late: 0,
    keyframes: 0,
    attempts: 0,
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

  let handlers = null;
  let pc = null;
  let ctl = null;
  let attempt = 0;
  let never = 0;
  let fellBack = 0;
  let drawnSince = false;
  let lastStatsAt = 0;
  let lossMonitor = policy.createLossMonitor();
  let timers = {};
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

  function active() {
    return state.phase === 'active';
  }

  function setPhase(phase) {
    state.phase = phase;
    document.body.dataset.transport = active() ? 'webrtc' : 'ws';
    document.body.dataset.rtcPhase = phase;
  }

  function render() {
    if (!lines) return;
    const now = performance.now();
    trim(state.drawn, now);
    trim(state.bytes, now);
    const fps = state.drawn.length;
    const bits = state.bytes.reduce((total, entry) => total + entry[1], 0) * 8;
    const latencies = state.latency.slice(-120).map((entry) => entry[1]);
    const offsetKind = active() ? 'rtc' : 'ws';
    const rows = [
      ['transport', active() ? 'WebRTC data channel' : 'WebSocket' + (wanted ? ' (' + state.phase + ')' : '')],
      [
        'path',
        active() && state.pair
          ? state.pair.type + ' ' + state.pair.remote
          : active()
            ? 'connecting'
            : 'TCP via the share URL',
      ],
      [
        'rtt',
        (active() ? [state.pcRtt, state.ctlRtt] : [state.wsRtt]).filter((value) => value !== null).join(' / ') + ' ms',
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
      ['attempts', String(state.attempts)],
    ];
    if (active()) rows.push(['sender', 'queued ' + state.queued + ' B dropped ' + state.serverDropped]);
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
      next.searchParams.set('transport', wanted ? 'ws' : 'webrtc');
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

  function clearTimers() {
    for (const name of Object.keys(timers)) {
      clearTimeout(timers[name]);
      clearInterval(timers[name]);
    }
    timers = {};
  }

  function closePeer() {
    const retry = timers.retry;
    const start = timers.begin;
    clearTimers();
    timers.retry = retry;
    timers.begin = start;
    const peer = pc;
    pc = ctl = null;
    peer?.close();
  }

  function ask() {
    if (ctl && ctl.readyState === 'open') ctl.send(JSON.stringify({ t: 'keyframe' }));
  }

  function ping() {
    if (ctl && ctl.readyState === 'open') ctl.send(JSON.stringify({ t: 'ping', c: Date.now() }));
  }

  function fail(reason) {
    if (state.phase === 'idle' || state.phase === 'waiting' || state.phase === 'gave-up') return;
    const carried = active();
    closePeer();
    state.note = reason;
    state.pair = null;
    if (carried) fellBack++;
    else never++;
    const delay = policy.retryDelay(never, fellBack, mode === 'force');
    setPhase(delay === null ? 'gave-up' : 'waiting');
    if (carried) handlers.fallback(reason);
    if (delay !== null) timers.retry = setTimeout(begin, delay);
  }

  function commit() {
    clearInterval(timers.probe);
    clearTimeout(timers.probeEnd);
    never = 0;
    drawnSince = false;
    lossMonitor.reset();
    lastStatsAt = Date.now();
    setPhase('active');
    state.note = '';
    handlers.commit(attempt);
    timers.firstDraw = setTimeout(
      () => !drawnSince && document.visibilityState === 'visible' && fail('WebRTC video was not drawn'),
      FIRST_DRAW_MS,
    );
    timers.quiet = setInterval(() => Date.now() - lastStatsAt > QUIET_MS && fail('WebRTC went quiet'), 1000);
    timers.stable = setTimeout(() => {
      fellBack = 0;
    }, policy.STABLE_MS);
  }

  function onVideo(buffer) {
    if (state.phase === 'probing') {
      if (!policy.usableKeyframe(buffer)) return;
      commit();
    } else if (!active()) return;
    handlers.video(buffer);
  }

  function opened(peer) {
    if (peer !== pc) return;
    clearTimeout(timers.connect);
    setPhase('probing');
    ask();
    timers.probe = setInterval(ask, PROBE_ASK_MS);
    timers.probeEnd = setTimeout(() => fail('WebRTC delivered no keyframe'), PROBE_MS);
  }

  async function begin() {
    timers.begin = timers.retry = undefined;
    if (!handlers || !handlers.ready() || state.phase === 'probing' || active() || state.phase === 'connecting') return;
    attempt++;
    state.attempts++;
    state.samples.rtc = [];
    state.offsets.rtc = null;
    state.pair = null;
    setPhase('connecting');
    const peer = new RTCPeerConnection({ iceServers });
    pc = peer;
    const ttl = query.get('ttl') === null ? DEFAULT_TTL_MS : Number(query.get('ttl'));
    const video = peer.createDataChannel(
      'video',
      ttl > 0 ? { ordered: false, maxPacketLifeTime: ttl } : { ordered: false, maxRetransmits: 0 },
    );
    video.binaryType = 'arraybuffer';
    video.addEventListener('message', (event) => peer === pc && onVideo(event.data));
    const control = peer.createDataChannel('ctl');
    ctl = control;
    control.addEventListener('message', (event) => {
      if (peer !== pc || typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.t === 'pong') sample('rtc', message.c, message.s);
      else if (message.t === 'stats') {
        lastStatsAt = Date.now();
        state.serverDropped = message.dropped;
        state.queued = message.queued;
        state.serverRtt = message.rtt;
        state.serverPair = message.pair;
      }
    });
    video.addEventListener('open', () => opened(peer));
    control.addEventListener('open', () => {
      if (peer !== pc) return;
      if (state.phase === 'probing') ask();
      if (visible) {
        ping();
        timers.ping = setInterval(ping, 2000);
      }
    });
    peer.addEventListener('connectionstatechange', () => {
      if (peer !== pc) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed')
        fail('WebRTC ' + peer.connectionState);
      else if (peer.connectionState === 'disconnected')
        setTimeout(() => peer === pc && peer.connectionState === 'disconnected' && fail('WebRTC disconnected'), 3000);
    });
    if (visible) timers.stats = setInterval(() => void readPair().catch(() => {}), 1000);
    timers.connect = setTimeout(() => peer === pc && fail('WebRTC did not connect'), CONNECT_MS);
    try {
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== 'complete') {
        await new Promise((resolve) => {
          const done = () => peer.iceGatheringState === 'complete' && resolve();
          peer.addEventListener('icegatheringstatechange', done);
          setTimeout(resolve, GATHER_MS);
        });
      }
      if (peer !== pc) return;
      handlers.send({ type: 'webrtc-offer', sdp: peer.localDescription.sdp, attempt });
    } catch (error) {
      if (peer === pc) fail(String(error));
    }
  }

  function stop() {
    clearTimeout(timers.retry);
    clearTimeout(timers.begin);
    closePeer();
    timers = {};
    setPhase('idle');
  }

  window.stimRtc = {
    wanted,
    visible,
    attach(options) {
      handlers = options;
    },
    schedule() {
      if (!wanted || timers.begin || timers.retry || state.phase !== 'idle') return;
      if (policy.retryDelay(never, fellBack, mode === 'force') === null) return;
      timers.begin = setTimeout(begin, BEGIN_DELAY_MS);
    },
    stop,
    answer(message) {
      if (!pc || message.attempt !== attempt) return;
      const peer = pc;
      peer
        .setRemoteDescription({ type: 'answer', sdp: message.sdp })
        .catch((error) => peer === pc && fail(String(error)));
    },
    refused(message) {
      if (message.attempt !== undefined && message.attempt !== attempt) return;
      fail(message.message || 'WebRTC failed');
    },
    keyframe() {
      if (!active() || !ctl || ctl.readyState !== 'open') return false;
      state.keyframes++;
      ask();
      if (mode !== 'force') {
        const why = lossMonitor.ask(Date.now());
        if (why) fail('WebRTC kept asking for keyframes');
      }
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
      drawnSince = true;
      if (!visible) return;
      const now = performance.now();
      state.drawn.push([now]);
      const offset = state.offsets[active() ? 'rtc' : 'ws'];
      if (offset !== null && capturedAt) {
        state.latency.push([now, Date.now() + offset - capturedAt]);
        if (state.latency.length > 600) state.latency.splice(0, 300);
      }
    },
    gap() {
      state.gaps++;
      if (active() && mode !== 'force' && lossMonitor.gap(Date.now())) fail('WebRTC lost too much video');
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
      return active() ? 'webrtc' : 'ws';
    },
  };

  setPhase('idle');
  if (visible) buildPanel();
})();
