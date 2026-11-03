'use strict';

const body = document.body;
const control = body.dataset.control === 'true';
const allowedButtons = (body.dataset.buttons || '').split(' ').filter(Boolean);
const canRotate = control && body.dataset.canRotate === 'true';
const viewOnly = body.dataset.viewOnly === 'true';
const device = document.getElementById('device');
const aperture = document.getElementById('aperture');
const screen = document.getElementById('screen');
const bezelBack = document.getElementById('bezel-back');
const bezelFront = document.getElementById('bezel-front');
const note = document.getElementById('note');
const statusBox = document.getElementById('status');
const statusText = document.getElementById('status-text');
const leftText = document.getElementById('left');
const context = screen.getContext('2d');
const overlay = window.createOverlay(
  document.getElementById('overlay'),
  window.matchMedia('(prefers-reduced-motion: reduce)').matches,
);

let artwork = null;
let expiresAt = null;
let live = false;
let finished = false;
let hasFrame = false;
let noteTimer = null;

function setStatus(state, text) {
  statusBox.dataset.state = state;
  statusText.textContent = text;
}

function showNote(text) {
  note.textContent = text;
  clearTimeout(noteTimer);
  if (text) noteTimer = setTimeout(() => (note.textContent = ''), 4000);
}

function timeLeft() {
  if (expiresAt === null) return '';
  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  const minutes = Math.round(seconds / 60);
  if (minutes >= 60) return Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min left';
  if (seconds >= 300) return minutes + ' min left';
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + ' left';
}

function refreshStatus() {
  if (finished) return;
  setStatus(live ? 'live' : 'waiting', live ? 'Live' : 'Waiting');
  leftText.textContent = timeLeft();
}
setInterval(() => {
  if (!finished) leftText.textContent = timeLeft();
}, 1000);

function finish(text) {
  finished = true;
  live = false;
  setStatus('ended', text);
  leftText.textContent = '';
}

/** Whether the artwork's screen opening has the shape of the frames now arriving. */
function fits(frameWidth, frameHeight) {
  if (!artwork) return false;
  const aspect = artwork.aperture.width / artwork.aperture.height;
  return Math.abs(frameWidth / frameHeight - aspect) / aspect < 0.01;
}

function layout(frameWidth, frameHeight) {
  const framed = fits(frameWidth, frameHeight);
  device.classList.toggle('framed', framed);
  bezelBack.hidden = bezelFront.hidden = !framed;
  const style = aperture.style;
  if (framed) {
    const a = artwork.aperture;
    device.style.setProperty('--ratio', String(artwork.width / artwork.height));
    style.inset = 'auto';
    style.left = (100 * a.x) / artwork.width + '%';
    style.top = (100 * a.y) / artwork.height + '%';
    style.width = (100 * a.width) / artwork.width + '%';
    style.height = (100 * a.height) / artwork.height + '%';
    style.borderRadius = (100 * artwork.cornerRadius) / artwork.width + 'cqw';
  } else {
    device.style.setProperty('--ratio', String(frameWidth / frameHeight));
    for (const name of ['left', 'top', 'width', 'height']) style.removeProperty(name);
    style.inset = '0';
    style.borderRadius = '';
  }
}

/** Draws one frame (an ImageBitmap, or a VideoFrame from a decoder) onto the screen. */
function renderFrame(source, width, height) {
  if (screen.width !== width || screen.height !== height) {
    screen.width = width;
    screen.height = height;
    layout(width, height);
  }
  context.drawImage(source, 0, 0, width, height);
  hasFrame = true;
}

async function showJpeg(blob) {
  const bitmap = await createImageBitmap(blob);
  renderFrame(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  if (!live && !finished) {
    live = true;
    refreshStatus();
  }
}

function load(image, src) {
  image.src = src;
  return image.decode().catch(() => {});
}

let artworkSeq = 0;

async function setArtwork(next) {
  const seq = ++artworkSeq;
  if (!next) {
    artwork = null;
    if (hasFrame) layout(screen.width, screen.height);
    return;
  }
  await Promise.all([load(bezelBack, next.background), load(bezelFront, next.foreground)]);
  if (seq !== artworkSeq) return;
  artwork = next;
  if (hasFrame) layout(screen.width, screen.height);
}

/** The keyframe bit of a video packet's flags; see VIDEO_KEYFRAME in packages/core/protocol.ts. */
const VIDEO_KEYFRAME = 1;
/** The Main profile the capture helper's encoder uses, at the level a 1280 px stream needs. */
const PROBE_CODEC = 'avc1.4d0028';
const MAX_DECODE_QUEUE = 3;
const KEYFRAME_ASK_MS = 500;

let decoder = null;
let decoderKey = '';
let decoded = false;
let waitingForKeyframe = true;
let keyframeAskedAt = 0;

function canDecodeVideo() {
  if (location.hash === '#jpeg' || typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function')
    return Promise.resolve(false);
  return VideoDecoder.isConfigSupported({ codec: PROBE_CODEC, optimizeForLatency: true }).then(
    (result) => result.supported === true,
    () => false,
  );
}

function askForKeyframe() {
  waitingForKeyframe = true;
  if (Date.now() - keyframeAskedAt < KEYFRAME_ASK_MS) return;
  keyframeAskedAt = Date.now();
  send({ type: 'keyframe' });
}

function closeDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  decoderKey = '';
}

/** A decoder that never produced a frame means this browser cannot play the stream; a later failure gets a keyframe. */
function decoderFailed() {
  closeDecoder();
  if (decoded) askForKeyframe();
  else useJpeg();
}

/** The NAL units of an Annex-B access unit. */
function nalUnits(bytes) {
  const units = [];
  let start = -1;
  let i = 0;
  while (i + 2 < bytes.length) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) units.push(bytes.subarray(start, bytes[i - 1] === 0 ? i - 1 : i));
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0) units.push(bytes.subarray(start));
  return units;
}

const nalType = (unit) => unit[0] & 31;

/** The access unit in the length-prefixed form an avcC description implies, without the parameter sets it carries. */
function lengthPrefixed(units) {
  const kept = units.filter((unit) => nalType(unit) !== 7 && nalType(unit) !== 8 && nalType(unit) !== 9);
  const out = new Uint8Array(kept.reduce((total, unit) => total + 4 + unit.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const unit of kept) {
    view.setUint32(at, unit.length);
    out.set(unit, at + 4);
    at += 4 + unit.length;
  }
  return out;
}

/** An AVCDecoderConfigurationRecord (ISO/IEC 14496-15) for one SPS and one PPS, with 4-byte NAL lengths. */
function avcC(sps, pps) {
  const out = new Uint8Array(11 + sps.length + pps.length);
  const view = new DataView(out.buffer);
  out.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1]);
  view.setUint16(6, sps.length);
  out.set(sps, 8);
  out[8 + sps.length] = 1;
  view.setUint16(9 + sps.length, pps.length);
  out.set(pps, 11 + sps.length);
  return out;
}

const hex = (value) => value.toString(16).padStart(2, '0');

function configure(sps, pps) {
  const description = avcC(sps, pps);
  const key = description.join(',');
  if (decoder && key === decoderKey) return;
  closeDecoder();
  decoder = new VideoDecoder({
    output: (frame) => {
      decoded = true;
      renderFrame(frame, frame.displayWidth, frame.displayHeight);
      frame.close();
      if (!live && !finished) {
        live = true;
        refreshStatus();
      }
    },
    error: decoderFailed,
  });
  decoder.configure({
    codec: 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]),
    description,
    optimizeForLatency: true,
  });
  decoderKey = key;
}

/** Decodes one video packet: the header the server's videoPacket writes, then an Annex-B access unit. */
function showVideo(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 21 || view.getUint8(0) !== 1) return;
  const keyframe = (view.getUint8(1) & VIDEO_KEYFRAME) !== 0;
  const units = nalUnits(new Uint8Array(buffer, view.getUint16(2)));
  if (keyframe) {
    const sps = units.find((unit) => nalType(unit) === 7);
    const pps = units.find((unit) => nalType(unit) === 8);
    if (!sps || !pps) return askForKeyframe();
    configure(sps, pps);
    waitingForKeyframe = false;
  } else if (waitingForKeyframe || !decoder) return;
  if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) return askForKeyframe();
  try {
    decoder.decode(
      new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta',
        timestamp: Math.round(view.getFloat64(8) * 1000),
        data: lengthPrefixed(units),
      }),
    );
  } catch {
    decoderFailed();
  }
}

/** Device clipboard reads waiting for their reply, by request id. */
const copies = new Map();

let me = null;
let busy = false;
let chosenName = '';
const roster = new Map();
const rosterList = document.getElementById('roster');
const eye = document.getElementById('eye');

function renderRoster() {
  const items = [...roster.values()]
    .toSorted((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)))
    .map((entry) => {
      const item = document.createElement('li');
      item.style.background = window.PALETTE[entry.color % window.PALETTE.length];
      item.style.color = window.PALETTE_TEXT[entry.color % window.PALETTE_TEXT.length];
      item.textContent = [...entry.name][0] ? [...entry.name][0].toUpperCase() : '?';
      item.title = entry.name + (entry.self ? ' (you)' : '') + (entry.viewOnly ? ', view only' : '');
      if (entry.self) item.classList.add('you');
      if (entry.viewOnly) item.append(eye.content.cloneNode(true));
      return item;
    });
  rosterList.replaceChildren(...items);
}

function showPresence(participants) {
  for (const participant of participants) {
    if (participant.touch === null) roster.delete(participant.id);
    else {
      roster.set(participant.id, {
        name: participant.name,
        color: participant.color,
        viewOnly: participant.viewOnly === true,
      });
    }
  }
  renderRoster();
  overlay.presence(participants);
}

const socketUrl = location.href
  .replace(/#.*$/, '')
  .replace(/^http/, 'ws')
  .replace(/\/[^/]*$/, '/ws');
let socket = null;
let pending = Promise.resolve();

function connect(codec) {
  roster.clear();
  me = null;
  overlay.clear();
  renderRoster();
  const current = new WebSocket(socketUrl + (codec === 'h264' ? '?codec=h264' : ''));
  socket = current;
  body.dataset.codec = codec;
  current.binaryType = 'arraybuffer';
  current.addEventListener('open', () => {
    if (chosenName) send({ type: 'name', name: chosenName });
  });
  current.addEventListener('message', (event) => {
    if (current !== socket) return;
    if (typeof event.data !== 'string') {
      if (new Uint8Array(event.data, 0, 1)[0] === 0xff) {
        const blob = new Blob([event.data], { type: 'image/jpeg' });
        pending = pending.then(() => showJpeg(blob)).catch(() => {});
      } else if (codec === 'h264') showVideo(event.data);
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type === 'hello') {
      expiresAt = Date.parse(message.expiresAt);
      refreshStatus();
    } else if (message.type === 'clipboard') {
      const waiting = copies.get(message.id);
      copies.delete(message.id);
      if (waiting && typeof message.text === 'string') waiting.resolve(message.text);
      else if (waiting) waiting.reject(new Error(message.error || 'The device did not return its clipboard.'));
    } else if (message.type === 'artwork') void setArtwork(message.artwork);
    else if (message.type === 'delayed') {
      live = !message.delayed && hasFrame;
      refreshStatus();
    } else if (message.type === 'you') {
      me = { id: message.id, name: message.name, color: message.color };
      roster.set(me.id, { ...me, self: true, viewOnly });
      renderRoster();
    } else if (message.type === 'presence') showPresence(message.participants);
    else if (message.type === 'busy') {
      busy = true;
      if (me) overlay.fade(me.id);
      showNote(message.name + ' is using the screen.');
    } else if (message.type === 'control') showNote(message.message || '');
    else if (message.type === 'ended') finish(message.message);
  });
  current.addEventListener('close', () => {
    if (finished || current !== socket) return;
    finish('Disconnected');
    showNote('Disconnected. Reload to reconnect.');
  });
}

/** Moves this viewer to JPEG once its own socket has closed, so the replacement never counts twice against the cap. */
function useJpeg() {
  closeDecoder();
  if (body.dataset.codec === 'jpeg') return;
  const previous = socket;
  socket = null;
  if (!previous || previous.readyState === 3) return connect('jpeg');
  previous.addEventListener('close', () => connect('jpeg'));
  previous.close();
}

const send = (message) => {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
};

void canDecodeVideo().then((supported) => connect(supported ? 'h264' : 'jpeg'));

for (const button of document.querySelectorAll('[data-button]')) {
  if (!control || !allowedButtons.includes(button.dataset.button)) button.remove();
  else button.addEventListener('click', () => send({ type: 'button', button: button.dataset.button }));
}
for (const button of document.querySelectorAll('[data-rotate]')) {
  if (!canRotate) button.remove();
  else button.addEventListener('click', () => send({ type: 'rotate', direction: button.dataset.rotate }));
}

const copyButton = document.getElementById('copy');
if (!control || !['ios', 'android'].includes(body.dataset.platform)) copyButton.remove();
else {
  const { writeClipboard } = globalThis.stimClipboard;
  let copyId = 0;
  copyButton.addEventListener('click', () => {
    if (!navigator.clipboard) return showNote('This browser gives the page no clipboard access.');
    const id = ++copyId;
    const text = new Promise((resolve, reject) => {
      copies.set(id, { resolve, reject });
      setTimeout(() => {
        if (copies.delete(id)) reject(new Error('The device did not answer in time.'));
      }, 15000);
    });
    send({ type: 'clipboard-get', id });
    writeClipboard(navigator.clipboard, globalThis.ClipboardItem, Blob, text).then(
      () => showNote('Copied the device clipboard.'),
      (error) => showNote(error && error.message ? error.message : 'The browser did not allow copying.'),
    );
  });
}

const upgrade = document.getElementById('upgrade');
upgrade.hidden = body.dataset.upgrade !== 'true';
document.getElementById('upgrade-open').addEventListener('click', () => {
  document.getElementById('upgrade-fields').hidden = false;
  upgrade.querySelector('input').focus();
});
const upgradeResult = new URLSearchParams(location.search).get('upgrade');
if (upgradeResult) {
  showNote(upgradeResult === 'limited' ? 'Too many wrong passwords. Try again later.' : 'Wrong password.');
  history.replaceState(null, '', location.pathname);
}

const nameForm = document.getElementById('name-form');
const nameInput = document.getElementById('name-input');
const NAME_KEY = 'stim-share-name';
function rememberedName() {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}
function chooseName(name) {
  chosenName = name;
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* the name is still used for this page */
  }
  nameForm.hidden = true;
  if (name) send({ type: 'name', name });
}
if (body.dataset.askName === 'true') {
  const remembered = rememberedName();
  if (remembered === null) nameForm.hidden = false;
  else chosenName = remembered;
  nameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    chooseName(nameInput.value);
  });
  document.getElementById('name-skip').addEventListener('click', () => chooseName(''));
}

const fullscreen = document.getElementById('full');
if (document.fullscreenEnabled) {
  fullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  });
} else fullscreen.remove();

if (control) {
  const { createMirroredGesture, createTouchTracker } = globalThis.stimGestures;
  const TOUCH_SETTLE_MS = 40;
  let down = false;
  const at = (event) => {
    const box = screen.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    };
  };
  const mirror = createMirroredGesture();
  const touches = createTouchTracker();
  const markers = [0, 1].map(() => {
    const marker = document.createElement('div');
    const style = marker.style;
    style.position = 'absolute';
    style.width = style.height = '24px';
    style.marginLeft = style.marginTop = '-12px';
    style.boxSizing = 'border-box';
    style.border = '2px solid #fff';
    style.borderRadius = '50%';
    style.background = 'rgba(255, 255, 255, 0.35)';
    style.pointerEvents = 'none';
    style.display = 'none';
    aperture.appendChild(marker);
    return marker;
  });
  const drawMarkers = () => {
    const pair = mirror.pair;
    markers.forEach((marker, index) => {
      marker.style.display = pair ? 'block' : 'none';
      if (!pair) return;
      marker.style.left = 100 * pair[index].x + '%';
      marker.style.top = 100 * pair[index].y + '%';
    });
  };
  const sendTouch = (message) => {
    if (message.phase === 'down') busy = false;
    if (!busy || message.phase === 'down') send(message);
    if (me) {
      const second = message.x2 === undefined ? null : { x: message.x2, y: message.y2 };
      overlay.own(me, message.phase, message.x, message.y, busy, second);
    }
    if (message.phase === 'up') busy = false;
  };
  let queuedMove = null;
  let frame = 0;
  const flushMove = () => {
    frame = 0;
    if (queuedMove) sendTouch(queuedMove);
    queuedMove = null;
  };
  const emit = (messages) => {
    for (const message of messages) {
      if (message.phase === 'move' && message.x2 !== undefined) {
        queuedMove = message;
        frame ||= requestAnimationFrame(flushMove);
      } else {
        queuedMove = null;
        sendTouch(message);
      }
    }
  };
  let settle = 0;
  const touched = () => {
    clearTimeout(settle);
    if (touches.pending) settle = setTimeout(() => emit(touches.settle()), TOUCH_SETTLE_MS);
  };
  screen.tabIndex = 0;
  screen.addEventListener('pointerdown', (event) => {
    screen.focus();
    screen.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (event.pointerType === 'touch') {
      emit(touches.down(event.pointerId, at(event)));
      touched();
    } else if (event.altKey) {
      emit(mirror.down(at(event), event.shiftKey));
      drawMarkers();
    } else {
      down = true;
      sendTouch({ type: 'touch', phase: 'down', ...at(event) });
    }
  });
  screen.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') {
      emit(touches.move(event.pointerId, at(event)));
      touched();
      return;
    }
    if (mirror.active) {
      emit(mirror.move(at(event), event.shiftKey, event.altKey));
      if (!event.altKey) emit(mirror.release());
    } else if (down) sendTouch({ type: 'touch', phase: 'move', ...at(event) });
    else if (event.altKey) mirror.hover(at(event), event.shiftKey);
    else emit(mirror.release());
    drawMarkers();
  });
  const up = (event) => {
    if (event.pointerType === 'touch') {
      emit(touches.up(event.pointerId));
      touched();
    } else if (mirror.active) {
      emit(mirror.up(at(event), event.shiftKey));
      drawMarkers();
    } else if (down) {
      down = false;
      sendTouch({ type: 'touch', phase: 'up', ...at(event) });
    }
  };
  screen.addEventListener('pointerup', up);
  screen.addEventListener('pointercancel', up);
  screen.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch' && !mirror.active) {
      mirror.release();
      drawMarkers();
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.key !== 'Alt') return;
    emit(mirror.release());
    drawMarkers();
  });
  window.addEventListener('blur', () => {
    emit(mirror.release());
    drawMarkers();
  });
  document.addEventListener('paste', (event) => {
    if (document.activeElement !== screen || !['ios', 'android'].includes(body.dataset.platform)) return;
    event.preventDefault();
    const request = globalThis.stimClipboard.pasteRequest(event.clipboardData.getData('text/plain'));
    if (request && request.message) send(request.message);
    else if (request) showNote(request.note);
  });
  const keys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Escape: 'escape' };
  const typed = { Enter: '\n', Tab: '\t', Backspace: '\b' };
  screen.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = keys[event.key];
    if (key && !event.shiftKey) {
      send({ type: 'key', key });
      event.preventDefault();
      return;
    }
    const text =
      typed[event.key] ?? (event.key.length === 1 && event.key >= ' ' && event.key <= '~' ? event.key : null);
    if (text === null) return;
    send({ type: 'text', text });
    event.preventDefault();
  });
}

for (const group of document.querySelectorAll('.group')) group.hidden = !group.querySelector('button');
