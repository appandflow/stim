'use strict';

const body = document.body;
const rtc = window.stimRtc;
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
let away = false;
let resuming = false;
let noteTimer = null;
let retryTimer = null;
let probing = false;
let reconnecting = false;
let attempt = 0;
let missingSince = null;
let releaseInput = () => {};
const PROBE_TIMEOUT_MS = 10000;

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
  if (reconnecting)
    setStatus('waiting', missingSince === null ? 'Reconnecting...' : 'Share not found. Trying again...');
  else if (away) setStatus('waiting', 'Waiting for the device');
  else setStatus(live ? 'live' : 'waiting', live ? 'Live' : 'Waiting');
  leftText.textContent = reconnecting ? '' : timeLeft();
}
setInterval(() => {
  if (!finished && !reconnecting) leftText.textContent = timeLeft();
}, 1000);

function finish(text) {
  finished = true;
  reconnecting = false;
  clearTimeout(retryTimer);
  delete body.dataset.reconnecting;
  live = false;
  away = false;
  resuming = false;
  delete body.dataset.away;
  document.getElementById('upgrade').hidden = true;
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
  if (resuming) {
    resuming = false;
    away = false;
    delete body.dataset.away;
  }
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
  if (rtc.active === 'webrtc' && rtc.keyframe()) return;
  rtc.countKeyframe();
  send({ type: 'keyframe' });
}

/** Decoded frames waiting for a refresh: two, drawing the oldest. ?queue=1 keeps only the newest. */
const QUEUE_LIMIT = new URLSearchParams(location.search).get('queue') === '1' ? 1 : 2;
const undrawn = [];
let drawScheduled = 0;

function closeDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  decoderKey = '';
  dropUndrawn();
}

function dropUndrawn() {
  for (const frame of undrawn.splice(0)) frame.close();
}

function drawUndrawn() {
  drawScheduled = 0;
  const frame = undrawn.shift();
  if (!frame) return;
  if (undrawn.length) drawScheduled = requestAnimationFrame(drawUndrawn);
  renderFrame(frame, frame.displayWidth, frame.displayHeight);
  rtc.drawn(frame.timestamp / 1000);
  frame.close();
  if (!live && !finished) {
    live = true;
    refreshStatus();
  }
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
      while (undrawn.length >= QUEUE_LIMIT) undrawn.shift().close();
      undrawn.push(frame);
      drawScheduled ||= requestAnimationFrame(drawUndrawn);
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

let lastSequence = -1;
const REORDER_MS = Number(new URLSearchParams(location.search).get('reorder')) || 40;
const reordered = new Map();
let reorderTimer = null;

function resetSequence() {
  lastSequence = -1;
  reordered.clear();
  clearTimeout(reorderTimer);
  reorderTimer = null;
}

/** Plays a packet of the unordered channel; one after a missing packet cannot decode unless it is a keyframe. */
function playSequenced(buffer, gap) {
  const view = new DataView(buffer);
  lastSequence = view.getUint32(4);
  if (gap) {
    rtc.gap();
    if ((view.getUint8(1) & VIDEO_KEYFRAME) === 0) return askForKeyframe();
  }
  showVideo(buffer);
}

function drainReordered() {
  while (reordered.has(lastSequence + 1)) {
    const next = reordered.get(lastSequence + 1);
    reordered.delete(lastSequence + 1);
    playSequenced(next, false);
  }
  if (!reordered.size) {
    clearTimeout(reorderTimer);
    reorderTimer = null;
  }
}

function giveUpOnMissing() {
  reorderTimer = null;
  if (!reordered.size) return;
  const next = Math.min(...reordered.keys());
  const buffer = reordered.get(next);
  reordered.delete(next);
  playSequenced(buffer, true);
  drainReordered();
  if (reordered.size) reorderTimer = setTimeout(giveUpOnMissing, REORDER_MS);
}

/** An unordered, lossy channel delivers packets late and out of order; waits briefly for a missing one. */
function receiveRtc(buffer) {
  if (buffer.byteLength < 21) return;
  const sequence = new DataView(buffer).getUint32(4);
  if (lastSequence >= 0 && sequence <= lastSequence) {
    rtc.late();
    return;
  }
  if (lastSequence < 0 || sequence === lastSequence + 1) {
    playSequenced(buffer, false);
    drainReordered();
    return;
  }
  reordered.set(sequence, buffer);
  reorderTimer ??= setTimeout(giveUpOnMissing, REORDER_MS);
}

/** Decodes one video packet: the header the server's videoPacket writes, then an Annex-B access unit. */
function showVideo(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 21 || view.getUint8(0) !== 1) return;
  const keyframe = (view.getUint8(1) & VIDEO_KEYFRAME) !== 0;
  rtc.received(buffer.byteLength);
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

const peopleBox = document.getElementById('people');
const peopleButton = document.getElementById('people-button');
const peoplePanel = document.getElementById('people-panel');
const peopleTitle = document.getElementById('people-title');
const peopleList = document.getElementById('people-list');
const people = globalThis.stimPeople;
const shareControl = control || viewOnly;
const RENAME_MS = 5000;
const ROSTER_MAX = 5;
const TOUCH_MS = 10000;
const NAME_MAX = 24;
let lastRenameAt = -Infinity;
const touchTimers = new Map();

function paint(element, color) {
  element.style.background = window.PALETTE[color % window.PALETTE.length];
  element.style.color = window.PALETTE_TEXT[color % window.PALETTE_TEXT.length];
}

function avatar(row) {
  const item = document.createElement('span');
  item.className = 'avatar';
  paint(item, row.color);
  item.textContent = row.initial;
  return item;
}

const selfRow = document.createElement('li');
const selfAvatar = document.createElement('span');
selfAvatar.className = 'avatar';
const selfInfo = document.createElement('span');
selfInfo.className = 'person';
const selfName = document.createElement('span');
selfName.className = 'person-name';
const selfRole = document.createElement('span');
selfRole.className = 'person-role';
selfInfo.append(selfName, selfRole);
const changeName = document.createElement('button');
changeName.type = 'button';
changeName.className = 'link';
changeName.textContent = 'Change name';
const nameEdit = document.createElement('form');
nameEdit.className = 'person-edit';
nameEdit.hidden = true;
const editInput = document.createElement('input');
editInput.className = 'field';
editInput.maxLength = NAME_MAX;
editInput.autocomplete = 'nickname';
editInput.setAttribute('aria-label', 'Your name');
const editSave = document.createElement('button');
editSave.type = 'submit';
editSave.className = 'primary small';
editSave.textContent = 'Save';
const editCancel = document.createElement('button');
editCancel.type = 'button';
editCancel.className = 'link';
editCancel.textContent = 'Cancel';
const editNote = document.createElement('p');
editNote.className = 'person-note';
editNote.setAttribute('role', 'status');
nameEdit.append(editInput, editSave, editCancel, editNote);
selfRow.append(selfAvatar, selfInfo, changeName, nameEdit);

function editing(on) {
  selfInfo.hidden = on;
  changeName.hidden = on;
  nameEdit.hidden = !on;
  editNote.textContent = '';
  if (on) {
    editInput.value = me ? me.name : '';
    editInput.focus();
    editInput.select();
  } else if (peoplePanel.contains(document.activeElement) || document.activeElement === document.body) {
    changeName.focus();
  }
}

function describe(row) {
  const name = document.createElement('span');
  name.className = 'person-name';
  if (row.kind === 'viewer') name.textContent = row.name;
  else {
    const tag = document.createElement('span');
    tag.className = 'tag';
    paint(tag, row.color);
    tag.textContent = row.name;
    name.append(tag);
  }
  if (row.self) {
    const mark = document.createElement('span');
    mark.className = 'you-mark';
    mark.textContent = ' (you)';
    name.append(mark);
  }
  return name;
}

function renderPeople() {
  const rows = people.peopleRows([...roster.values()], shareControl);
  peopleBox.hidden = rows.length === 0;
  peopleTitle.textContent = people.peopleCount(rows.length);
  peopleButton.setAttribute('aria-label', `People: ${peopleTitle.textContent}`);
  const own = rows.find((row) => row.self);
  const items = rows
    .filter((row) => !row.self)
    .map((row) => {
      const item = document.createElement('li');
      const info = document.createElement('span');
      info.className = 'person';
      const role = document.createElement('span');
      role.className = 'person-role';
      role.textContent = row.role;
      info.append(describe(row), role);
      item.append(avatar(row), info);
      return item;
    });
  if (own) {
    paint(selfAvatar, own.color);
    selfAvatar.textContent = own.initial;
    selfName.replaceChildren(...describe(own).childNodes);
    selfRole.textContent = own.role;
  }
  for (const child of peopleList.querySelectorAll(':scope > li')) if (child !== selfRow) child.remove();
  if (!own) selfRow.remove();
  else if (peopleList.firstChild !== selfRow) peopleList.prepend(selfRow);
  peopleList.append(...items);
}

function renderRoster() {
  const rows = people.peopleRows([...roster.values()], shareControl);
  const hidden = rows.length > ROSTER_MAX ? rows.length - (ROSTER_MAX - 1) : 0;
  const items = rows.slice(0, rows.length - hidden).map((row) => {
    const item = avatar(row);
    if (row.self) item.classList.add('you');
    if (row.viewOnly) item.append(eye.content.cloneNode(true));
    return item;
  });
  if (hidden) {
    const more = document.createElement('span');
    more.className = 'avatar more';
    more.textContent = `+${hidden}`;
    items.push(more);
  }
  rosterList.replaceChildren(...items);
  renderPeople();
}

function showPresence(participants) {
  for (const participant of participants) {
    if (participant.touch === null) {
      roster.delete(participant.id);
      clearTimeout(touchTimers.get(participant.id));
      touchTimers.delete(participant.id);
    } else {
      const known = roster.get(participant.id);
      const phase = participant.touch ? participant.touch.phase : null;
      roster.set(participant.id, {
        name: participant.name,
        color: participant.color,
        kind: participant.kind,
        viewOnly: participant.viewOnly === true,
        touching: phase === null ? known?.touching === true : phase !== 'up',
      });
      if (phase !== null) {
        clearTimeout(touchTimers.get(participant.id));
        if (phase !== 'up') {
          touchTimers.set(
            participant.id,
            setTimeout(() => {
              const entry = roster.get(participant.id);
              if (entry) roster.set(participant.id, { ...entry, touching: false });
              renderRoster();
            }, TOUCH_MS),
          );
        }
      }
    }
  }
  renderRoster();
  overlay.presence(participants);
}

function setPeopleOpen(open, restoreFocus) {
  peoplePanel.hidden = !open;
  peopleButton.setAttribute('aria-expanded', String(open));
  if (!open) {
    editing(false);
    if (restoreFocus) peopleButton.focus();
  }
}

peopleButton.addEventListener('click', () => {
  if (peoplePanel.hidden) setOptionsOpen(false, false);
  setPeopleOpen(peoplePanel.hidden, false);
});
peopleBox.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !peoplePanel.hidden) {
    event.stopPropagation();
    setPeopleOpen(false, true);
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!peoplePanel.hidden && !peopleBox.contains(event.target)) setPeopleOpen(false, false);
});
changeName.addEventListener('click', () => editing(true));
editCancel.addEventListener('click', () => editing(false));
nameEdit.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = editInput.value.trim();
  if (!name || (me && name === me.name)) return editing(false);
  if (Date.now() - lastRenameAt < RENAME_MS) {
    editNote.textContent = 'You can change your name again in a few seconds.';
    return;
  }
  chooseName(name);
  editing(false);
});

const socketUrl = location.href
  .replace(/[?#].*$/, '')
  .replace(/^http/, 'ws')
  .replace(/\/[^/]*$/, '/ws');
const pageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
  byte.toString(16).padStart(2, '0'),
).join('');
let socket = null;
let kickClipboard = () => {};
let pending = Promise.resolve();

function sendName(name) {
  lastRenameAt = Date.now();
  send({ type: 'name', name });
}

function connect(codec) {
  roster.clear();
  for (const timer of touchTimers.values()) clearTimeout(timer);
  touchTimers.clear();
  me = null;
  overlay.clear();
  renderRoster();
  const viaRtc = codec === 'h264' && rtc.wanted && !rtcFailed;
  const current = new WebSocket(
    `${socketUrl}?id=${pageId}${codec === 'h264' ? '&codec=h264' : ''}${viaRtc ? '&transport=webrtc' : ''}`,
  );
  const previous = socket;
  socket = current;
  if (previous && previous.readyState <= WebSocket.OPEN) previous.close();
  body.dataset.codec = codec;
  body.dataset.transport = viaRtc ? 'webrtc' : 'ws';
  resetSequence();
  if (!viaRtc) rtc.stop();
  current.binaryType = 'arraybuffer';
  current.addEventListener('open', () => {
    if (rtc.visible) {
      const clock = () => send({ type: 'clock', c: Date.now() });
      clock();
      const clockTimer = setInterval(
        () => (current === socket && current.readyState === 1 ? clock() : clearInterval(clockTimer)),
        2000,
      );
    }
    if (viaRtc) startRtc();
    kickClipboard();
    if (chosenName) sendName(chosenName);
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
      reconnecting = false;
      attempt = 0;
      missingSince = null;
      clearTimeout(retryTimer);
      delete body.dataset.reconnecting;
      if (typeof message.title === 'string') document.title = message.title;
      expiresAt = Date.parse(message.expiresAt);
      refreshStatus();
    } else if (message.type === 'title') {
      if (typeof message.title === 'string') document.title = message.title;
    } else if (message.type === 'clipboard') {
      const waiting = copies.get(message.id);
      copies.delete(message.id);
      if (waiting && typeof message.text === 'string') waiting.resolve(message.text);
      else if (waiting) waiting.reject(new Error(message.error || 'The device did not return its clipboard.'));
    } else if (message.type === 'clock') rtc.clock(message);
    else if (message.type === 'webrtc-answer') void rtc.answer(message.sdp).catch((error) => rtc.failed(String(error)));
    else if (message.type === 'webrtc-failed') rtc.failed(message.message || 'WebRTC failed');
    else if (message.type === 'artwork') void setArtwork(message.artwork);
    else if (message.type === 'delayed') {
      if (away) return;
      live = !message.delayed && hasFrame;
      refreshStatus();
    } else if (message.type === 'waiting') {
      rtc.stop();
      dropUndrawn();
      away = true;
      resuming = false;
      live = false;
      body.dataset.away = 'true';
      refreshStatus();
    } else if (message.type === 'resumed') {
      dropUndrawn();
      resuming = true;
      live = false;
      waitingForKeyframe = true;
      refreshStatus();
      resetSequence();
      if (viaRtc && !rtcFailed) startRtc();
      else if (codec === 'h264') askForKeyframe();
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
    lostConnection();
  });
}

let rtcFailed = false;

function startRtc() {
  void rtc
    .start({
      send,
      video: receiveRtc,
      opened: () => {
        waitingForKeyframe = true;
        resetSequence();
      },
      failed: () => {
        rtcFailed = true;
        const previous = socket;
        socket = null;
        if (!previous || previous.readyState === 3) return connect('h264');
        previous.addEventListener('close', () => connect('h264'));
        previous.close();
      },
    })
    .catch((error) => rtc.failed(String(error)));
}

function retryIn(delay) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(probe, delay);
}

function lostConnection() {
  live = false;
  away = false;
  resuming = false;
  waitingForKeyframe = true;
  delete body.dataset.away;
  reconnecting = true;
  body.dataset.reconnecting = 'true';
  for (const waiting of copies.values()) waiting.reject(new Error('The connection was lost.'));
  copies.clear();
  releaseInput();
  overlay.clear();
  refreshStatus();
  retryIn(globalThis.stimReconnect.reconnectDelay(attempt++));
}

async function probe() {
  clearTimeout(retryTimer);
  if (probing || finished) return;
  probing = true;
  let verdict = 'retry';
  const abort = new AbortController();
  const giveUp = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(location.href.replace(/[?#].*$/, ''), {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: abort.signal,
    });
    verdict = globalThis.stimReconnect.probeVerdict(response.status, await response.text());
  } catch {
    verdict = 'retry';
  }
  clearTimeout(giveUp);
  probing = false;
  if (finished) return;
  if (verdict === 'viewer') {
    missingSince = null;
    return connect(body.dataset.codec);
  }
  if (verdict === 'login') return location.reload();
  if (verdict === 'missing') {
    missingSince ??= Date.now();
    if (Date.now() - missingSince > globalThis.stimReconnect.MISSING_GIVE_UP_MS) {
      return finish('This share has ended.');
    }
    refreshStatus();
    return retryIn(globalThis.stimReconnect.MISSING_RETRY_MS);
  }
  missingSince = null;
  refreshStatus();
  retryIn(globalThis.stimReconnect.reconnectDelay(attempt++));
}

function retryNow() {
  if (finished || probing) return;
  if (!reconnecting) {
    if (socket && socket.readyState === WebSocket.CLOSED) lostConnection();
    return;
  }
  attempt = 0;
  retryIn(0);
}
window.addEventListener('online', retryNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') retryNow();
});

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
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify(message));
  return true;
};

for (const surface of [device, document.getElementById('toolbar')]) {
  surface.addEventListener('contextmenu', (event) => event.preventDefault());
}

void canDecodeVideo().then((supported) => connect(supported ? 'h264' : 'jpeg'));

for (const button of document.querySelectorAll('[data-button]')) {
  if (!control || !allowedButtons.includes(button.dataset.button)) button.remove();
  else button.addEventListener('click', () => send({ type: 'button', button: button.dataset.button }));
}
for (const button of document.querySelectorAll('[data-rotate]')) {
  if (!canRotate) button.remove();
  else button.addEventListener('click', () => send({ type: 'rotate', direction: button.dataset.rotate }));
}

const options = document.getElementById('options');
const optionsButton = document.getElementById('options-button');
const optionsPanel = document.getElementById('options-panel');
const syncSwitch = document.getElementById('sync-clipboard');
const syncNote = document.getElementById('sync-note');
const syncTitle = document.getElementById('sync-title');
const syncHelp = document.getElementById('sync-help');
const copyFallback = document.getElementById('copy-fallback');
const pasteDevice = document.getElementById('paste-device');
const copyDevice = document.getElementById('copy-device');
const copyChip = document.getElementById('copy-chip');
const SYNC_KEY = 'stim-share-clipboard-sync';
const COPY_TIMEOUT_MS = 15000;

function setOptionsOpen(open, restoreFocus) {
  optionsPanel.hidden = !open;
  if (!open) {
    copyFallback.hidden = true;
    copyFallback.value = '';
  }
  optionsButton.setAttribute('aria-expanded', String(open));
  if (open) setPeopleOpen(false, false);
  else if (restoreFocus) optionsButton.focus();
}

if (!control || !['ios', 'android'].includes(body.dataset.platform)) options.remove();
else {
  const { writeClipboard, nextPollDelay, createClipboardSync } = globalThis.stimClipboard;
  const sync = createClipboardSync();
  const pasteKey = /Mac/.test(navigator.userAgent) ? 'Command' : 'Control';
  const touchFirst = window.matchMedia('(pointer: coarse)');
  let syncOn = true;
  let readPermission = 'unknown';
  let asked = false;
  let copyId = 0;
  let delay = nextPollDelay(0, true);
  let pollTimer = null;
  let polling = false;
  let chipText = null;

  try {
    syncOn = localStorage.getItem(SYNC_KEY) !== 'off';
  } catch {
    syncOn = true;
  }
  const remember = () => {
    try {
      localStorage.setItem(SYNC_KEY, syncOn ? 'on' : 'off');
      return true;
    } catch {
      return false;
    }
  };
  options.hidden = false;
  syncSwitch.checked = syncOn;

  const active = () =>
    syncOn &&
    !touchFirst.matches &&
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    socket !== null &&
    socket.readyState === WebSocket.OPEN;

  function requestDeviceText(poll) {
    const id = ++copyId;
    return new Promise((resolve, reject) => {
      copies.set(id, { resolve, reject });
      setTimeout(() => {
        if (copies.delete(id)) reject(new Error('The device did not answer in time.'));
      }, COPY_TIMEOUT_MS);
      send({ type: 'clipboard-get', id, ...(poll ? { poll: true } : {}) });
    });
  }

  function showChip(text) {
    chipText = text;
    copyChip.hidden = text === null;
  }

  function refreshNote() {
    const touch = touchFirst.matches;
    syncTitle.textContent = touch ? 'Clipboard' : 'Sync clipboard';
    syncSwitch.hidden = touch;
    syncSwitch.disabled = touch;
    syncHelp.textContent = touch
      ? 'Copy text between this phone or tablet and the device. Your browser only lets a page use the clipboard when you tap, so there is no automatic sync.'
      : 'Copy text between this browser and the device while this page is focused.';
    pasteDevice.hidden = !touch;
    syncNote.hidden = touch || (syncOn && readPermission === 'granted');
    syncNote.textContent = `Press ${pasteKey}-V on the device screen to paste.`;
  }

  function showFallback(text) {
    copyFallback.value = text;
    copyFallback.hidden = false;
    copyFallback.focus();
    copyFallback.select();
  }

  async function writeToBrowser(text) {
    try {
      await navigator.clipboard.writeText(text);
      sync.wrote(text);
      showChip(null);
    } catch {
      showChip(text);
    }
  }

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = active() ? setTimeout(pollOnce, delay) : null;
  }

  async function pollOnce() {
    pollTimer = null;
    if (polling || !active()) return;
    polling = true;
    let ok = true;
    try {
      const text = await requestDeviceText(true);
      if (active() && sync.deviceRead(text)) await writeToBrowser(text);
    } catch {
      ok = false;
    }
    polling = false;
    delay = nextPollDelay(delay, ok);
    schedule();
  }

  async function readBrowser() {
    if (!active() || readPermission !== 'granted') return;
    try {
      const request = sync.browserRead(await navigator.clipboard.readText());
      if (request && request.message) {
        // A send the server then drops is recorded as sent; the next poll may replace the browser text.
        if (send(request.message)) sync.sent(request.message.text);
      } else if (request) showNote(request.note);
    } catch (error) {
      if (error && error.name === 'NotAllowedError') readPermission = 'denied';
      refreshNote();
    }
  }

  function returned() {
    delay = nextPollDelay(0, true);
    schedule();
    void readBrowser();
  }

  async function askToRead() {
    if (asked || !syncOn || touchFirst.matches || readPermission !== 'prompt') return;
    asked = true;
    try {
      await navigator.clipboard.readText();
      readPermission = 'granted';
    } catch (error) {
      if (error && error.name === 'NotAllowedError') readPermission = 'denied';
    }
    refreshNote();
    void readBrowser();
  }

  async function queryRead() {
    if (!navigator.permissions || !navigator.clipboard || !navigator.clipboard.readText) {
      readPermission = 'unsupported';
    } else {
      try {
        const status = await navigator.permissions.query({ name: 'clipboard-read' });
        readPermission = status.state;
        status.addEventListener('change', () => {
          readPermission = status.state;
          refreshNote();
          void readBrowser();
        });
      } catch {
        readPermission = 'unsupported';
      }
    }
    refreshNote();
    void readBrowser();
  }

  syncSwitch.addEventListener('change', () => {
    syncOn = syncSwitch.checked;
    remember();
    if (syncOn) {
      returned();
      void askToRead();
    } else {
      clearTimeout(pollTimer);
      pollTimer = null;
      showChip(null);
    }
    refreshNote();
  });
  copyChip.addEventListener('click', async () => {
    const text = chipText;
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      sync.wrote(text);
      showChip(null);
      showNote('Copied the device clipboard.');
    } catch {
      showNote('The browser did not allow copying.');
    }
  });
  pasteDevice.addEventListener('click', async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      return showNote('This browser gives the page no clipboard access.');
    }
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch (error) {
      return showNote(
        error && error.name === 'NotAllowedError'
          ? 'The browser did not allow reading your clipboard.'
          : 'Your clipboard could not be read.',
      );
    }
    const request = globalThis.stimClipboard.pasteRequest(text);
    setOptionsOpen(false, false);
    if (request && request.message) {
      if (send(request.message)) sync.sent(request.message.text);
      else showNote('Not connected to the device.');
    } else showNote(request ? request.note : 'Your clipboard has no text.');
  });
  copyDevice.addEventListener('click', async () => {
    copyFallback.hidden = true;
    const text = requestDeviceText().then((value) => {
      sync.deviceRead(value);
      return value;
    });
    try {
      if (!navigator.clipboard) throw new Error('This browser gives the page no clipboard access.');
      await writeClipboard(navigator.clipboard, globalThis.ClipboardItem, Blob, text);
      sync.wrote(await text);
      showChip(null);
      showNote('Copied the device clipboard.');
    } catch (error) {
      const value = await text.catch(() => null);
      if (value) {
        showNote('The browser did not allow copying. Select the text below to copy it.');
        showFallback(value);
      } else showNote(error && error.message ? error.message : 'The browser did not allow copying.');
    }
  });
  optionsButton.addEventListener('click', () => setOptionsOpen(optionsPanel.hidden, false));
  options.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !optionsPanel.hidden) {
      event.stopPropagation();
      setOptionsOpen(false, true);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!optionsPanel.hidden && !options.contains(event.target)) setOptionsOpen(false, false);
    void askToRead();
  });
  document.addEventListener('keydown', () => void askToRead());
  window.addEventListener('focus', returned);
  window.addEventListener('blur', schedule);
  document.addEventListener('visibilitychange', () =>
    document.visibilityState === 'visible' ? returned() : schedule(),
  );
  kickClipboard = returned;
  touchFirst.addEventListener('change', () => {
    refreshNote();
    returned();
  });
  refreshNote();
  void queryRead();
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
  if (name) sendName(name);
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
  let mirror = createMirroredGesture();
  let touches = createTouchTracker();
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
  let queuedMove = null;
  let touching = false;
  const sendTouch = (message) => {
    if (message.phase !== 'move') queuedMove = null;
    if (message.phase === 'down') {
      if (!live) return;
      touching = true;
    } else if (!touching || (message.phase === 'move' && !live)) return;
    if (message.phase === 'down') busy = false;
    if (!busy || message.phase === 'down') send(message);
    if (me) {
      const second = message.x2 === undefined ? null : { x: message.x2, y: message.y2 };
      overlay.own(me, message.phase, message.x, message.y, busy, second);
    }
    if (message.phase === 'up') {
      busy = false;
      touching = false;
    }
  };
  let frame = 0;
  const flushMove = () => {
    frame = 0;
    if (queuedMove) sendTouch(queuedMove);
    queuedMove = null;
  };
  const emit = (messages) => {
    for (const message of messages) {
      if (message.phase === 'move') {
        queuedMove = message;
        frame ||= requestAnimationFrame(flushMove);
      } else {
        sendTouch(message);
      }
    }
  };
  let settle = 0;
  const touched = () => {
    clearTimeout(settle);
    if (touches.pending) settle = setTimeout(() => emit(touches.settle()), TOUCH_SETTLE_MS);
  };
  releaseInput = () => {
    down = false;
    touching = false;
    busy = false;
    queuedMove = null;
    clearTimeout(settle);
    mirror = createMirroredGesture();
    touches = createTouchTracker();
    drawMarkers();
  };
  screen.tabIndex = 0;
  screen.addEventListener('pointerdown', (event) => {
    screen.focus();
    screen.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (!live) return;
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
    if (!live) return;
    if (event.pointerType === 'touch') {
      emit(touches.move(event.pointerId, at(event)));
      touched();
      return;
    }
    if (mirror.active) {
      emit(mirror.move(at(event), event.shiftKey, event.altKey));
      if (!event.altKey) emit(mirror.release());
    } else if (down) emit([{ type: 'touch', phase: 'move', ...at(event) }]);
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
  const apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
  screen.addEventListener('keydown', (event) => {
    if (!live) return;
    const message = globalThis.stimKeys.keyMessage(event, apple);
    if (!message) return;
    send(message);
    event.preventDefault();
  });
}

for (const group of document.querySelectorAll('.group')) group.hidden = !group.querySelector('button');
