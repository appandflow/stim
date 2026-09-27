import type { NdjsonRecord } from '../ndjson.ts';

/** The isolated world the input listener runs in, so the page's own scripts cannot see or replace it. */
export const INPUT_WORLD = 'stim';
export const INPUT_BINDING = '__stimInput';

/**
 * Observes trusted clicks, key presses, text input and wheel scrolls in the page and reports them through the
 * binding, coalesced: one action per click, per typing burst in a field, per repeated key and per scroll burst.
 * Typed text is never reported, only its length. Input up to 3 seconds after a `stim-takeover` event on the window,
 * which Stim's Take over dispatches while it sends input, is dropped; so is input just before one, since the event
 * and the input reach the page by different routes.
 */
export const INPUT_LISTENER: string = `(() => {
  const send = globalThis.${INPUT_BINDING};
  if (typeof send !== 'function') return;
  const BURST_MS = 1000, FLUSH_MS = 1000, MAX_WAIT_MS = 3000, TAKEOVER_MS = 3000, MAX_ACTIONS = 50;
  let pending = [], marks = [], dropped = 0, lastKeyAt = -Infinity, timer = 0, firstAt = 0;
  const clip = (value, max) => {
    const text = String(value || '').replace(/\\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 3) + '...' : text;
  };
  const ROLES = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option', 'textbox', 'combobox', 'searchbox'];
  const INTERACTIVE = 'a[href],button,input,textarea,select,label,summary,[contenteditable=""],[contenteditable=true],[data-testid],'
    + ROLES.map((role) => '[role=' + role + ']').join(',');
  const describe = (node, withText) => {
    if (!(node instanceof Element)) return null;
    const el = node.closest(INTERACTIVE) || node;
    const tag = el.tagName.toLowerCase();
    let out = tag;
    if (el.id) out += '#' + clip(el.id, 40);
    if (tag === 'input') out += '[type=' + (el.getAttribute('type') || 'text') + ']';
    const role = el.getAttribute('role');
    if (role) out += '[role=' + clip(role, 20) + ']';
    const testId = el.getAttribute('data-testid');
    if (testId) out += '[data-testid=' + clip(testId, 40) + ']';
    const field = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    const name = el.getAttribute('aria-label') || (field
      ? el.getAttribute('placeholder') || el.getAttribute('name')
      : withText ? el.textContent : '');
    const label = clip(name, 40);
    return label ? out + ' "' + label.replace(/"/g, "'") + '"' : out;
  };
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    const now = performance.now();
    marks = marks.filter((at) => at > now - TAKEOVER_MS - MAX_WAIT_MS - BURST_MS);
    const actions = pending
      .filter((action) => !marks.some((at) => at >= action.start - TAKEOVER_MS && at <= action.end + 500))
      .map(({ start, end, ...action }) => ({ ...action, at: Math.round(performance.timeOrigin + start) }));
    const lost = dropped;
    pending = [];
    dropped = 0;
    if (actions.length || lost) send(JSON.stringify({ actions, dropped: lost }));
  };
  const add = (action, merge) => {
    const now = performance.now();
    const last = pending[pending.length - 1];
    if (last && last.command === action.command && now - last.end < BURST_MS && merge(last)) {
      last.end = now;
    } else if (pending.length >= MAX_ACTIONS) {
      dropped += 1;
    } else {
      if (!pending.length) firstAt = now;
      pending.push({ ...action, start: now, end: now });
    }
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(FLUSH_MS, firstAt + MAX_WAIT_MS - now)));
  };
  const typed = (target, characters) =>
    add({ command: 'type', target, characters }, (last) => last.target === target && (last.characters += characters, true));
  const origin = (event) => event.composedPath()[0] || event.target;
  addEventListener('stim-takeover', () => marks.push(performance.now()), true);
  addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    add({ command: 'click', target: describe(origin(event), true), x: Math.round(event.clientX), y: Math.round(event.clientY) }, () => false);
  }, true);
  addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.isComposing) return;
    const key = event.key;
    if (!key || key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'CapsLock') return;
    const target = describe(origin(event), false);
    const modifiers = (event.ctrlKey ? 'Control+' : '') + (event.altKey ? 'Alt+' : '') + (event.metaKey ? 'Meta+' : '');
    if (key.length === 1 && !modifiers) {
      lastKeyAt = performance.now();
      typed(target, 1);
      return;
    }
    const name = modifiers + (key === ' ' ? 'Space' : key);
    add({ command: 'press', target, key: name, count: 1 }, (last) => last.key === name && last.target === target && (last.count += 1, true));
  }, true);
  addEventListener('input', (event) => {
    if (!event.isTrusted || typeof event.inputType !== 'string' || !event.inputType.startsWith('insert')) return;
    if (performance.now() - lastKeyAt < 100) return;
    typed(describe(origin(event), false), typeof event.data === 'string' && event.data ? event.data.length : 1);
  }, true);
  addEventListener('wheel', (event) => {
    if (!event.isTrusted) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const deltaX = event.deltaX * scale, deltaY = event.deltaY * scale;
    add({ command: 'scroll', deltaX, deltaY, x: Math.round(event.clientX), y: Math.round(event.clientY) }, (last) => {
      last.deltaX += deltaX;
      last.deltaY += deltaY;
      return true;
    });
  }, { capture: true, passive: true });
})();`;

type WebInputAction =
  | { command: 'click'; at: number; target: string | null; x: number; y: number }
  | { command: 'type'; at: number; target: string | null; characters: number }
  | { command: 'press'; at: number; target: string | null; key: string; count: number }
  | { command: 'scroll'; at: number; deltaX: number; deltaY: number; x: number; y: number };

export interface WebInputBatch {
  actions: WebInputAction[];
  dropped: number;
}

const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value.slice(0, 200) : null);

function parseAction(value: unknown): WebInputAction | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (!num(entry.at)) return null;
  const { at } = entry;
  switch (entry.command) {
    case 'click':
      return num(entry.x) && num(entry.y)
        ? { command: 'click', at, target: text(entry.target), x: entry.x, y: entry.y }
        : null;
    case 'type':
      return num(entry.characters)
        ? { command: 'type', at, target: text(entry.target), characters: entry.characters }
        : null;
    case 'press': {
      const key = text(entry.key);
      return key && num(entry.count)
        ? { command: 'press', at, target: text(entry.target), key, count: entry.count }
        : null;
    }
    case 'scroll':
      return num(entry.deltaX) && num(entry.deltaY) && num(entry.x) && num(entry.y)
        ? { command: 'scroll', at, deltaX: entry.deltaX, deltaY: entry.deltaY, x: entry.x, y: entry.y }
        : null;
    default:
      return null;
  }
}

/** The batch the input listener sent, keeping only well-formed actions. */
export function parseInputBatch(payload: string): WebInputBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { actions: [], dropped: 0 };
  }
  const batch = (parsed ?? {}) as { actions?: unknown; dropped?: unknown };
  return {
    actions: Array.isArray(batch.actions) ? batch.actions.map(parseAction).filter((action) => action !== null) : [],
    dropped: num(batch.dropped) && batch.dropped > 0 ? batch.dropped : 0,
  };
}

function scrollSummary(deltaX: number, deltaY: number): string {
  const parts = [
    Math.round(deltaY) ? `${deltaY > 0 ? 'down' : 'up'} ${Math.abs(Math.round(deltaY))}px` : '',
    Math.round(deltaX) ? `${deltaX > 0 ? 'right' : 'left'} ${Math.abs(Math.round(deltaX))}px` : '',
  ].filter(Boolean);
  return parts.length ? `Scrolled ${parts.join(' and ')}` : 'Scrolled';
}

function summary(action: WebInputAction): string {
  switch (action.command) {
    case 'click':
      return `Clicked ${action.target ?? 'the page'}`;
    case 'type':
      return `Typed ${action.characters} character${action.characters === 1 ? '' : 's'} into ${action.target ?? 'the page'}`;
    case 'press':
      return `Pressed ${action.key}${action.count > 1 ? ` x${action.count}` : ''}${action.target ? ` in ${action.target}` : ''}`;
    case 'scroll':
      return scrollSummary(action.deltaX, action.deltaY);
  }
}

/**
 * The `agent` records for input the DevTools client `driver` sent to the owned page `targetId`, in the shape of
 * agent-device's action records.
 */
export function webAgentRecords(batch: WebInputBatch, targetId: string, driver: string, now: number): NdjsonRecord[] {
  const base = { src: 'agent', level: 'info', event: 'agent_action', platform: 'web', deviceId: targetId, driver };
  const records: NdjsonRecord[] = batch.actions.map((action) => {
    const { at, command, ...details } = action;
    return { ts: at, ...base, msg: summary(action), command, details };
  });
  if (batch.dropped) {
    records.push({
      ts: now,
      ...base,
      msg: `${batch.dropped} more input event${batch.dropped === 1 ? ' was' : 's were'} not recorded`,
      command: 'input',
    });
  }
  return records;
}
