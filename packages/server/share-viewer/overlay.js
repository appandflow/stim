'use strict';

/**
 * Draws who touches the device over the screen: a dot, a fading trail and a name for each participant, a ripple for a
 * tap and an outline for the element an agent acted on. Points are fractions of the screen box the canvas covers.
 */
const PALETTE = ['#ff9f0a', '#bf5af2', '#0a84ff', '#ff375f', '#30d158', '#ffd60a', '#64d2ff', '#ac8e68'];
/** White text on a dark color, near-black on a light one. */
const TEXT = PALETTE.map((hex) => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#17151f' : '#fff';
});
const TRAIL_MS = 600;
const FADE_MS = 300;
const LABEL_MS = 1000;
const RIPPLE_MS = 450;
const OUTLINE_MS = 600;
const STALE_MS = 15000;
const TAP_MS = 200;
const DOT = 14;
const LABEL_CHARS = 16;
const SMOOTHING = 0.45;

function touch(who, phase, x, y, second, now) {
  who.lastAt = now;
  if (phase === 'down') {
    who.down = true;
    who.moved = false;
    who.upAt = null;
    who.points = [];
    who.shown = { x, y };
  }
  if (phase === 'move' && who.target && Math.hypot(x - who.target.x, y - who.target.y) > 0.004) who.moved = true;
  who.target = { x, y };
  who.second = second ? { x: second.x, y: second.y } : null;
  if (!who.second) who.shownSecond = null;
  else if (!who.shownSecond) who.shownSecond = { ...who.second };
  who.points.push({ x, y, t: now });
  if (phase === 'up') {
    who.down = false;
    who.upAt = now;
    who.faded = false;
    if (!who.moved) who.ripple = { x, y, t: now };
  }
}

function gesture(who, g, now) {
  const duration = g.kind === 'tap' ? Math.max(g.durationMs, TAP_MS) : Math.max(g.durationMs, 1);
  who.swipe = { from: g.from, to: g.to || g.from, start: now, duration };
  touch(who, 'down', g.from.x, g.from.y, null, now);
  if (g.target) who.outline = { rect: g.target, start: now, hold: duration + OUTLINE_MS };
}

function createOverlay(canvas, reduced) {
  const ctx = canvas.getContext('2d');
  const people = new Map();
  let width = 0;
  let height = 0;
  let scale = 1;
  let running = false;

  function resize() {
    scale = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    kick();
  }
  new ResizeObserver(resize).observe(canvas);

  function person(id, info) {
    let found = people.get(id);
    if (!found) {
      found = {
        id,
        points: [],
        target: null,
        shown: null,
        second: null,
        shownSecond: null,
        down: false,
        moved: false,
        upAt: null,
        lastAt: 0,
        ripple: null,
        swipe: null,
        outline: null,
        faded: false,
      };
      people.set(id, found);
    }
    Object.assign(found, info);
    return found;
  }

  function advance(who, now) {
    const swipe = who.swipe;
    if (swipe) {
      const t = Math.min(1, (now - swipe.start) / swipe.duration);
      const x = swipe.from.x + (swipe.to.x - swipe.from.x) * t;
      const y = swipe.from.y + (swipe.to.y - swipe.from.y) * t;
      if (t >= 1) {
        who.swipe = null;
        touch(who, 'up', swipe.to.x, swipe.to.y, null, now);
      } else if (t > 0) touch(who, 'move', x, y, null, now);
    } else if (who.down && now - who.lastAt > STALE_MS) touch(who, 'up', who.target.x, who.target.y, null, now);
    if (who.shown && who.target) {
      const ease = reduced ? 1 : SMOOTHING;
      who.shown.x += (who.target.x - who.shown.x) * ease;
      who.shown.y += (who.target.y - who.shown.y) * ease;
      if (who.shownSecond && who.second) {
        who.shownSecond.x += (who.second.x - who.shownSecond.x) * ease;
        who.shownSecond.y += (who.second.y - who.shownSecond.y) * ease;
      }
    }
  }

  const px = (point) => ({ x: point.x * width, y: point.y * height });

  function dot(point, color, alpha, radius) {
    const at = px(point);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  function label(who, point, alpha) {
    const full = [...who.name];
    const text = full.length > LABEL_CHARS ? full.slice(0, LABEL_CHARS - 1).join('') + '…' : who.name;
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const boxWidth = ctx.measureText(text).width + 14;
    const at = px(point);
    const left = Math.max(2, Math.min(width - boxWidth - 2, at.x + DOT * 0.8));
    const top = Math.max(2, Math.min(height - 22, at.y - DOT * 0.8 - 22));
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.roundRect(left, top, boxWidth, 20, 10);
    ctx.fillStyle = PALETTE[who.color % PALETTE.length];
    ctx.fill();
    ctx.fillStyle = TEXT[who.color % TEXT.length];
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + 7, top + 10.5);
  }

  function draw(who, now) {
    const color = PALETTE[who.color % PALETTE.length];
    const sinceUp = who.upAt === null ? 0 : now - who.upAt;
    const fade = who.down ? 1 : Math.max(0, 1 - sinceUp / FADE_MS);
    if (!reduced && who.points.length > 1) {
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      for (let i = 1; i < who.points.length; i++) {
        const age = now - who.points[i].t;
        if (age >= TRAIL_MS) continue;
        const from = px(who.points[i - 1]);
        const to = px(who.points[i]);
        ctx.globalAlpha = 0.6 * (1 - age / TRAIL_MS) * (who.faded ? 0.4 : 1);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
    }
    if (who.outline) {
      const age = now - who.outline.start;
      const alpha = age < who.outline.hold ? 1 : Math.max(0, 1 - (age - who.outline.hold) / FADE_MS);
      if (alpha > 0) {
        const r = who.outline.rect;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.strokeRect(r.x * width, r.y * height, r.width * width, r.height * height);
      } else who.outline = null;
    }
    if (who.ripple && !reduced) {
      const age = now - who.ripple.t;
      if (age < RIPPLE_MS) {
        const at = px(who.ripple);
        ctx.globalAlpha = 0.7 * (1 - age / RIPPLE_MS);
        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(at.x, at.y, DOT * (1 + (1.2 * age) / RIPPLE_MS), 0, Math.PI * 2);
        ctx.stroke();
      } else who.ripple = null;
    }
    if (who.shown && fade > 0) {
      const alpha = 0.85 * fade * (who.faded ? 0.4 : 1);
      const radius = DOT * (who.down ? 1 : 0.5 + 0.5 * fade);
      dot(who.shown, color, alpha, radius);
      if (who.shownSecond) dot(who.shownSecond, color, alpha, radius);
    }
    if (who.shown && (who.down || sinceUp < LABEL_MS)) {
      label(who, who.shown, who.down ? 1 : Math.max(0, 1 - Math.max(0, sinceUp - (LABEL_MS - FADE_MS)) / FADE_MS));
    }
  }

  function live(who, now) {
    return (
      who.down ||
      who.swipe !== null ||
      who.ripple !== null ||
      who.outline !== null ||
      (who.upAt !== null && now - who.upAt < LABEL_MS)
    );
  }

  function frame() {
    running = false;
    const now = performance.now();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let again = false;
    for (const who of people.values()) {
      advance(who, now);
      draw(who, now);
      again = again || live(who, now);
    }
    ctx.globalAlpha = 1;
    if (again) kick();
  }

  function kick() {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  }

  return {
    /** Participants that changed, as the share socket's `presence` message lists them. */
    presence(participants) {
      const now = performance.now();
      for (const p of participants) {
        if (p.touch === null) {
          people.delete(p.id);
          continue;
        }
        const who = person(p.id, { name: p.name, color: p.color });
        if (p.touch) touch(who, p.touch.phase, p.touch.x, p.touch.y, p.touch.second, now);
        if (p.gesture) gesture(who, p.gesture, now);
      }
      kick();
    },
    /** This viewer's own finger, drawn without the round trip; `faded` while another viewer holds the screen. */
    own(info, phase, x, y, faded, second) {
      const who = person(info.id, { name: info.name, color: info.color });
      who.faded = faded;
      touch(who, phase, x, y, second, performance.now());
      kick();
    },
    fade(id) {
      const who = people.get(id);
      if (who) who.faded = true;
      kick();
    },
    leave(id) {
      people.delete(id);
      kick();
    },
    clear() {
      people.clear();
      kick();
    },
  };
}

window.createOverlay = createOverlay;
window.PALETTE = PALETTE;
window.PALETTE_TEXT = TEXT;
