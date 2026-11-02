const STYLE = `
:root { color-scheme: light dark; --bg: #f5f5f7; --fg: #1d1d1f; --muted: #6e6e73; --card: #fff; --line: #d2d2d7; --accent: #5521ff; --on-accent: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #f5f5f7; --muted: #a1a1a6; --card: #1c1c1e; --line: #38383a; --accent: #b39cff; --on-accent: #15121d; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; flex-direction: column; align-items: center; }
header { width: 100%; padding: 12px 16px; display: flex; gap: 12px; align-items: center; justify-content: space-between; color: var(--muted); font-size: 13px; }
.logo { height: 18px; width: auto; fill: var(--accent); display: block; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input[type=password]:focus-visible { outline-offset: 0; border-color: var(--accent); }
a { color: var(--accent); }
footer { padding: 0 16px 16px; color: var(--muted); font-size: 12px; }
main { flex: 1; width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 16px 16px; gap: 12px; }
form.login { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; width: min(360px, 100%); display: flex; flex-direction: column; gap: 12px; }
input[type=password] { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.error { color: #d70015; margin: 0; }
#screen { max-width: 100%; max-height: calc(100vh - 140px); border-radius: 18px; background: #000; touch-action: none; user-select: none; -webkit-user-drag: none; }
#screen.control { cursor: pointer; outline: none; }
.buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
`;

const LOGO = `<svg class="logo" role="img" aria-label="Stim" viewBox="0 0 157.1 75.3" xmlns="http://www.w3.org/2000/svg"><path d="m157.09  42.9v4.57c0  1.88-.07  3.93-.21  6.15-.07  2.23-.28  4.48-.63  6.77-.35  2.23-.91  4.25-1.69  6.06-.7  1.82-1.62  3.31-2.74  4.48-1.12  1.17-2.56  1.76-4.32  1.76-1.55  0-2.74-.53-3.58-1.58-.77-1.11-1.34-2.4-1.69-3.87-.35-1.46-.56-2.96-.63-4.48  0-1.52  0-2.72  0-3.6  0-2.64 .11-5.21 .32-7.73 .21-2.52 .32-5.1 .32-7.73  0-.29  0-.82  0-1.58s-.07-1.52-.21-2.29c-.14-.76-.39-1.44-.74-2.02-.28-.59-.74-.88-1.37-.88-1.26  0-2.28 .56-3.06  1.67-.77  1.05-1.41  2.31-1.9  3.78-.49  1.46-.84  2.93-1.05  4.39-.21  1.41-.35  2.46-.42  3.16-.14 .76-.28  1.9-.42  3.43-.07  1.52-.21  3.19-.42  5.01-.14  1.82-.42  3.69-.84  5.63-.35  1.88-.84  3.6-1.48  5.19-.56  1.52-1.3  2.78-2.21  3.78-.91 1-2.04  1.49-3.37  1.49-1.69  0-2.99-.62-3.9-1.85-.91-1.23-1.58-2.67-2-4.31-.42-1.64-.7-3.31-.84-5.01-.07-1.7-.1-3.02-.1-3.96  0-1  0-1.96  0-2.9 .07-.94 .11-1.9 .11-2.9  0-.41  0-1.08  0-2.02s-.04-1.96-.1-3.08c0-1.17-.07-2.37-.21-3.6-.07-1.23-.21-2.34-.42-3.34-.21-1.05-.53-1.9-.95-2.55-.42-.64-.91-.97-1.48-.97-.91  0-1.76 .5-2.53  1.49-.77 .94-1.44  2.08-2  3.43-.56  1.29-1.02  2.58-1.37  3.87-.28  1.29-.42  2.23-.42  2.81v.53c0  2.81 .21  5.57 .63  8.26 .42  2.7 .63  5.45 .63  8.26  0  1.64-.63  3.16-1.9  4.57-1.26  1.35-3.02  2.02-5.27  2.02-1.62  0-2.95-.5-4.01-1.49-1.05-1.05-1.93-2.4-2.64-4.04-.7-1.64-1.26-3.43-1.69-5.36-.35-1.99-.6-3.93-.74-5.8-.14-1.93-.25-3.66-.32-5.19  0-1.58  0-2.75  0-3.52  0-.88-.04-2.17-.11-3.87  0-1.7 .04-3.54 .11-5.54 .14-1.99 .35-4.01 .63-6.06 .28-2.11 .74-4.01  1.37-5.71 .63-1.7  1.44-3.08  2.42-4.13  1.05-1.11  2.39-1.67  4.01-1.67  1.83  0  3.3 .41  4.43  1.23  1.2 .82  1.79  2.05  1.79  3.69  0  .35-.04 .7-.1  1.05  0  .35-.04 .67-.1 .97 .77-.94  1.72-1.87  2.85-2.81  1.12-1  2.32-1.87  3.58-2.64  1.34-.82  2.74-1.46  4.22-1.93  1.48-.53  2.95-.79  4.43-.79  1.41  0  2.67 .32  3.8 .97  1.12 .64  2.11  1.46  2.95  2.46 .84 .94  1.55  1.96  2.11  3.08s.95  2.17  1.16  3.16c.7-1.05  1.55-2.11  2.53-3.16  1.05-1.11  2.18-2.08  3.37-2.9s2.5-1.49  3.9-2.02c1.48-.53  2.99-.79  4.53-.79  1.48  0  2.74 .44  3.8  1.32  1.05 .88  1.97  2.02  2.74  3.43 .77  1.35  1.37  2.9  1.79  4.66 .42  1.7 .77  3.4  1.05  5.1 .28  1.64 .46  3.19 .53  4.66 .07  1.41 .11  2.52 .11  3.34z"/><path d="m86.16  8.18c0  .85-.23  1.61-.7  2.28-.41 .67-.97  1.28-1.67  1.83-.7 .49-1.46 .88-2.29  1.19-.82 .24-1.58 .37-2.29 .37-1.17  0-2.2-.3-3.08-.91-.88-.61-1.32-1.55-1.32-2.83  0-.91 .21-1.7 .62-2.37 .47-.73  1.03-1.31  1.67-1.73 .64-.49  1.38-.85  2.2-1.1 .82-.24  1.61-.37  2.37-.37  1.11  0  2.14 .27  3.08 .82s1.41  1.49  1.41  2.83zm.7  31.04v2.74c0  .91-.03  1.8-.09  2.65-.06  1.03-.09  2.43-.09  4.2  0  1.7-.06  3.56-.18  5.57-.12  2.01-.32  4.05-.62  6.12-.23  2.07-.64  3.96-1.23  5.66-.59  1.7-1.38  3.1-2.37  4.2-.94  1.03-2.14  1.58-3.6  1.64-1.11 .06-2.05-.4-2.81-1.37-.76-.97-1.41-2.22-1.93-3.74-.47-1.58-.82-3.32-1.05-5.2-.23-1.95-.41-3.8-.53-5.57-.12-1.83-.18-3.5-.18-5.02s0-2.65  0-3.38c0-.97  0-2.34  0-4.11  0-1.83 .06-3.77 .18-5.84s.32-4.17 .62-6.3c.35-2.13 .82-4.08  1.41-5.84 .64-1.76  1.46-3.19  2.46-4.29 1-1.1  2.26-1.64  3.78-1.64  1.58  0  2.78 .82  3.6  2.46s1.44  3.56  1.85  5.75c.41  2.19 .64  4.38 .7  6.57 .06  2.13 .09  3.71 .09  4.75z"/><path d="m58.38  75.07c-4.16  0-7.41-.59-9.76-1.77-2.29-1.12-4.01-2.73-5.19-4.84-1.11-2.11-1.79-4.65-2.02-7.63s-.35-6.3-.35-9.96c0-2.92 .09-5.83 .26-8.75 .18-2.98 .44-6.14 .79-9.49-.82  0-1.46 .03-1.93 .09-.47  0-.85  0-1.14  0-1.87  0-3.49-.43-4.83-1.3-1.41-.87-2.11-2.2-2.11-4  0-1.12 .41-2.11  1.23-2.98 .76-.87  1.76-1.61  2.99-2.23  1.23-.62  2.55-1.12  3.96-1.49  1.46-.37  2.84-.62  4.13-.74  0-1.74 .12-3.66 .35-5.77 .23-2.11 .64-4.06  1.23-5.86 .64-1.86  1.49-3.41  2.55-4.65s2.4-1.86  4.04-1.86c.94  0  1.76 .31  2.46 .93 .76 .56  1.38  1.3  1.85  2.23 .47 .87 .82  1.86  1.05  2.98 .23  1.12 .35  2.2 .35  3.26  0  1.24-.09  2.51-.26  3.82s-.5  2.92-.97  4.84c1-.12  1.67-.19  2.02-.19 .35-.06 .67-.09 .97-.09 1  0  2.02 .09  3.08 .28  1.11 .19  2.11 .5  2.99 .93 .94 .43  1.7  1.02  2.29  1.77 .59 .68 .88  1.52 .88  2.51  0  1.12-.44  2.11-1.32  2.98-.82 .87-1.87  1.61-3.16  2.23s-2.67  1.12-4.13  1.49c-1.46 .31-2.84 .53-4.13 .65-.35  2.54-.62  4.9-.79  7.07-.12  2.11-.26  4.25-.44  6.42-.12  1.05-.23  2.14-.35  3.26-.06  1.05-.09  2.14-.09  3.26  0  .81 .03  1.77 .09  2.88 .06  1.05 .26  2.08 .62  3.07 .35 .99 .91  1.86  1.67  2.61 .76 .68  1.82  1.02  3.16  1.02 .82  0  1.67-.06  2.55-.19 .88-.19  1.76-.28  2.64-.28  1.52  0  2.61 .56  3.25  1.68 .7  1.12  1.05  2.54  1.05  4.28  0  1.3-.38  2.45-1.14  3.44-.7 .93-1.61  1.68-2.72  2.23-1.11 .62-2.37  1.09-3.78  1.4-1.35 .31-2.64 .47-3.87 .47z"/><path d="m34.82  7.17c0  1.41-.49  2.64-1.48  3.68-.92  1.04-2.04  1.9-3.36  2.58-1.19 .67-2.41  1.41-3.66  2.21-1.25 .74-2.41  1.59-3.46  2.58-1.06 .92-1.91  1.96-2.57  3.13-.66  1.17-.99  2.48-.99  3.96  0  1.29 .33  2.45 .99  3.5s1.45  2.08  2.37  3.13c.99 .98  2.04  2.02  3.17  3.13  1.19  1.04  2.24  2.24  3.17  3.59 .99  1.29  1.81  2.76  2.47  4.41 .66  1.66 .99  3.59 .99  5.79  0  1.53-.36  3.28-1.09  5.24-.66  1.9-1.58  3.83-2.77  5.79-1.19  1.96-2.6  3.86-4.25  5.7-1.58  1.84-3.3  3.5-5.14  4.97-1.78  1.41-3.66  2.54-5.64  3.4-1.98 .92-3.89  1.38-5.74  1.38-2.04  0-3.86-.52-5.44-1.56-1.58-1.04-2.37-2.61-2.37-4.69  0-1.41 .36-2.7  1.09-3.86 .73-1.23  1.62-2.39  2.67-3.5  1.06-1.1  2.21-2.18  3.46-3.22  1.32-1.04  2.51-2.08  3.56-3.13  1.06-1.04  1.95-2.12  2.67-3.22 .73-1.17  1.09-2.39  1.09-3.68  0-1.78-.69-3.59-2.08-5.43-1.32-1.9-2.8-3.83-4.45-5.79-1.65-2.02-3.17-4.08-4.55-6.16-1.32-2.08-1.98-4.2-1.98-6.35  0-2.64 .76-5.4  2.28-8.28  1.52-2.94  3.46-5.61  5.84-8  2.37-2.45  5.05-4.48  8.01-6.07  2.97-1.59  5.9-2.39  8.8-2.39  2.31  0  4.29 .64  5.94  1.93  1.65  1.29  2.47  3.04  2.47  5.24z"/></svg>`;

const FOOTER =
  '<footer>Shared with <a href="https://stim.appandflow.com" target="_blank" rel="noopener noreferrer">Stim</a></footer>';

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(nonce: string, title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(title)}</title><style nonce="${nonce}">${STYLE}</style></head>
<body>${body}${FOOTER}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

export function loginPage(nonce: string, message: string | null): string {
  return page(
    nonce,
    'Shared app',
    `<header>${LOGO}</header><main><form class="login" method="post" action="login">
<strong>Enter the password you were given</strong>
<input type="password" name="password" autocomplete="off" autofocus required maxlength="128" aria-label="Password">
${message ? `<p class="error">${escape(message)}</p>` : ''}
<button class="primary" type="submit">View</button></form></main>`,
  );
}

export function endedPage(nonce: string): string {
  return page(nonce, 'Share ended', `<header>${LOGO}</header><main><p>This share has ended.</p></main>`);
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
    `<header>${LOGO}<span id="status">Connecting...</span></header>
<main><img id="screen" alt="Shared device screen" draggable="false">${buttons}</main>`,
    VIEWER,
  ).replace('<body>', `<body data-control="${options.control}">`);
}
