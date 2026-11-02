const STYLE = `
:root { color-scheme: light dark; --bg: #f5f5f7; --fg: #1d1d1f; --muted: #6e6e73; --card: #fff; --line: #d2d2d7; --accent: #0071e3; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #f5f5f7; --muted: #a1a1a6; --card: #1c1c1e; --line: #38383a; --accent: #2997ff; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; flex-direction: column; align-items: center; }
header { width: 100%; padding: 12px 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; color: var(--muted); font-size: 13px; }
main { flex: 1; width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 16px 16px; gap: 12px; }
form.login { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; width: min(360px, 100%); display: flex; flex-direction: column; gap: 12px; }
input[type=password] { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.error { color: #d70015; margin: 0; }
#screen { max-width: 100%; max-height: calc(100vh - 140px); border-radius: 18px; background: #000; touch-action: none; user-select: none; -webkit-user-drag: none; }
#screen.control { cursor: pointer; outline: none; }
.buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
`;

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(nonce: string, title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(title)}</title><style nonce="${nonce}">${STYLE}</style></head>
<body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

export function loginPage(nonce: string, message: string | null): string {
  return page(
    nonce,
    'Shared app',
    `<header><span>Stim web share</span></header><main><form class="login" method="post" action="login">
<strong>Enter the password you were given</strong>
<input type="password" name="password" autocomplete="off" autofocus required maxlength="128" aria-label="Password">
${message ? `<p class="error">${escape(message)}</p>` : ''}
<button class="primary" type="submit">View</button></form></main>`,
  );
}

export function endedPage(nonce: string): string {
  return page(nonce, 'Share ended', '<main><p>This share has ended.</p></main>');
}

const VIEWER = `
const screen = document.getElementById('screen');
const status = document.getElementById('status');
const control = document.body.dataset.control === 'true';
const ws = new WebSocket(location.href.replace(/^http/, 'ws').replace(/\\/[^/]*$/, '/ws'));
ws.binaryType = 'blob';
let url = null;
ws.onmessage = (event) => {
  if (typeof event.data !== 'string') {
    const next = URL.createObjectURL(event.data);
    screen.onload = () => { if (url) URL.revokeObjectURL(url); url = next; };
    screen.src = next;
    status.textContent = control ? 'Live, you can control it' : 'Live';
    return;
  }
  const message = JSON.parse(event.data);
  if (message.type === 'ended') status.textContent = message.message;
  else if (message.type === 'delayed') status.textContent = message.delayed ? 'Waiting for the device...' : 'Live';
  else if (message.type === 'control' && message.message) status.textContent = message.message;
};
ws.onclose = () => { if (!/ended/.test(status.textContent)) status.textContent = 'Disconnected. Reload to reconnect.'; };
const send = (message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
if (control) {
  screen.classList.add('control');
  screen.tabIndex = 0;
  let down = false;
  const at = (event) => {
    const box = screen.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
  };
  screen.addEventListener('pointerdown', (event) => { down = true; screen.focus(); screen.setPointerCapture(event.pointerId); send({ type: 'touch', phase: 'down', ...at(event) }); event.preventDefault(); });
  screen.addEventListener('pointermove', (event) => { if (down) send({ type: 'touch', phase: 'move', ...at(event) }); });
  const up = (event) => { if (!down) return; down = false; send({ type: 'touch', phase: 'up', ...at(event) }); };
  screen.addEventListener('pointerup', up);
  screen.addEventListener('pointercancel', up);
  screen.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const keys = { Enter: '\\n', Tab: '\\t', Backspace: '\\b' };
    const text = keys[event.key] ?? (event.key.length === 1 && event.key >= ' ' && event.key <= '~' ? event.key : null);
    if (text === null) return;
    send({ type: 'text', text });
    event.preventDefault();
  });
  for (const button of document.querySelectorAll('[data-button]')) {
    button.addEventListener('click', () => send({ type: 'button', button: button.dataset.button }));
  }
}
`;

export function viewerPage(nonce: string, options: { control: boolean; buttons: readonly string[] }): string {
  const labels: Record<string, string> = { home: 'Home', lock: 'Lock', back: 'Back', 'app-switch': 'Apps' };
  const buttons = options.control
    ? `<div class="buttons">${options.buttons
        .map(
          (button) =>
            `<button type="button" data-button="${escape(button)}">${escape(labels[button] ?? button)}</button>`,
        )
        .join('')}</div>`
    : '';
  return page(
    nonce,
    'Shared app',
    `<header><span>Stim web share</span><span id="status">Connecting...</span></header>
<main><img id="screen" alt="Shared device screen" draggable="false">${buttons}</main>`,
    VIEWER,
  ).replace('<body>', `<body data-control="${options.control}">`);
}
