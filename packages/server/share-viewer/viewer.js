'use strict';

const body = document.body;
const control = body.dataset.control === 'true';
const allowedButtons = (body.dataset.buttons || '').split(' ').filter(Boolean);
const canRotate = control && body.dataset.canRotate === 'true';
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
  if (seconds >= 3600) return Math.floor(seconds / 3600) + ' h ' + Math.round((seconds % 3600) / 60) + ' min left';
  if (seconds >= 300) return Math.round(seconds / 60) + ' min left';
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

const socket = new WebSocket(location.href.replace(/^http/, 'ws').replace(/\/[^/]*$/, '/ws'));
socket.binaryType = 'blob';
let pending = Promise.resolve();
socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') {
    pending = pending.then(() => showJpeg(event.data)).catch(() => {});
    return;
  }
  const message = JSON.parse(event.data);
  if (message.type === 'hello') {
    expiresAt = Date.parse(message.expiresAt);
    refreshStatus();
  } else if (message.type === 'artwork') void setArtwork(message.artwork);
  else if (message.type === 'delayed') {
    live = !message.delayed && hasFrame;
    refreshStatus();
  } else if (message.type === 'control') showNote(message.message || '');
  else if (message.type === 'ended') finish(message.message);
});
socket.addEventListener('close', () => {
  if (finished) return;
  finish('Disconnected');
  showNote('Disconnected. Reload to reconnect.');
});
const send = (message) => {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
};

for (const button of document.querySelectorAll('[data-button]')) {
  if (!control || !allowedButtons.includes(button.dataset.button)) button.remove();
  else button.addEventListener('click', () => send({ type: 'button', button: button.dataset.button }));
}
for (const button of document.querySelectorAll('[data-rotate]')) {
  if (!canRotate) button.remove();
  else button.addEventListener('click', () => send({ type: 'rotate', direction: button.dataset.rotate }));
}

document.getElementById('shot').addEventListener('click', () => {
  if (!hasFrame) return;
  screen.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'stim-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png');
});

const fullscreen = document.getElementById('full');
if (document.fullscreenEnabled) {
  fullscreen.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  });
} else fullscreen.remove();

if (control) {
  let down = false;
  const at = (event) => {
    const box = screen.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    };
  };
  screen.tabIndex = 0;
  screen.addEventListener('pointerdown', (event) => {
    down = true;
    screen.focus();
    screen.setPointerCapture(event.pointerId);
    send({ type: 'touch', phase: 'down', ...at(event) });
    event.preventDefault();
  });
  screen.addEventListener('pointermove', (event) => {
    if (down) send({ type: 'touch', phase: 'move', ...at(event) });
  });
  const up = (event) => {
    if (!down) return;
    down = false;
    send({ type: 'touch', phase: 'up', ...at(event) });
  };
  screen.addEventListener('pointerup', up);
  screen.addEventListener('pointercancel', up);
  const typed = { Enter: '\n', Tab: '\t', Backspace: '\b' };
  screen.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const text =
      typed[event.key] ?? (event.key.length === 1 && event.key >= ' ' && event.key <= '~' ? event.key : null);
    if (text === null) return;
    send({ type: 'text', text });
    event.preventDefault();
  });
}

for (const group of document.querySelectorAll('.group')) group.hidden = !group.querySelector('button');
