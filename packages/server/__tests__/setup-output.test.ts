import { expect, test } from 'vitest';
import { SetupPrinter, setupDisplayFor, type SetupDisplay } from '../src/setup-output.ts';

const CHECK = String.fromCharCode(0x2713);
const ARROW = String.fromCharCode(0x2192);

function printer(display: Partial<SetupDisplay>, verbose = false) {
  const out: string[] = [];
  const raw: string[] = [];
  const full: SetupDisplay = { tty: false, color: false, raw: (t) => void raw.push(t), ...display };
  return { out, raw, printer: new SetupPrinter((line) => void out.push(line), full, verbose) };
}

test.each([
  [true, {}, true],
  [true, { NO_COLOR: '1' }, false],
  [true, { TERM: 'dumb' }, false],
  [false, {}, false],
])('color for a terminal %s with %j is %s', (tty, env, color) => {
  expect(setupDisplayFor(tty, env, () => {})).toMatchObject({ tty, color });
});

test('a non-terminal prints plain marks, skips quiet running steps and hidden steps, and shows waiting steps', () => {
  const { out, raw, printer: p } = printer({});
  p.banner();
  p.step({ id: 'server', state: 'running', title: 'stim-server', running: 'Checking stim-server' });
  p.step({ id: 'server', state: 'ok', title: 'stim-server', text: 'stim-server 1.17.0 installed' });
  p.step({ id: 'preflight', state: 'ok', title: 'Preflight', hidden: true });
  p.step({ id: 'approve', state: 'running', title: 'Access approval', running: 'Waiting for approval' });
  p.step({ id: 'tools.Xcode', state: 'pending', title: 'Xcode', detail: 'Missing Xcode' });
  expect(out).toEqual([
    '[ok] stim-server 1.17.0 installed',
    '[..] Waiting for approval',
    '[pending] Xcode: Missing Xcode',
  ]);
  expect(raw).toEqual([]);
});

test('a color terminal draws the running step in place, then replaces it with a green check', () => {
  const { out, raw, printer: p } = printer({ tty: true, color: true });
  p.banner();
  expect(out.join('\n')).toContain('|___/');
  out.length = 0;
  p.step({ id: 'host', state: 'running', title: 'Stim Host', running: 'Installing Stim Host' });
  expect(raw).toEqual([`\u001b[33m${ARROW}\u001b[0m Installing Stim Host`]);
  p.step({ id: 'host', state: 'ok', title: 'Stim Host', text: 'Stim Host installed' });
  expect(raw[1]).toBe('\r\u001b[2K');
  expect(out).toEqual([`\u001b[32m${CHECK}\u001b[0m Stim Host installed`]);
});

test('a terminal without color prints no escape codes and no in-place line', () => {
  const { out, raw, printer: p } = printer({ tty: true, color: false });
  p.step({ id: 'host', state: 'running', title: 'Stim Host', running: 'Installing Stim Host' });
  p.step({ id: 'host', state: 'failed', title: 'Stim Host', text: 'Stim Host failed' });
  expect(raw).toEqual([]);
  expect(out).toEqual(['[..] Installing Stim Host', '[failed] Stim Host failed']);
});

test('verbose keeps the full step lines, including running ones and fixes', () => {
  const { out, printer: p } = printer({}, true);
  p.step({ id: 'server', state: 'running', title: 'stim-server', running: 'Checking' });
  p.step({
    id: 'tools.Xcode',
    state: 'pending',
    title: 'Xcode',
    detail: 'Missing',
    fix: 'Install Xcode',
    hidden: true,
  });
  expect(out).toEqual(['[running] stim-server', '[pending] Xcode: Missing\nFix: Install Xcode']);
});
