import { existsSync, readFileSync } from 'node:fs';
import { loginTitle } from './share-title.ts';
import { fileURLToPath } from 'node:url';

const BUNDLED = new URL('./share-viewer/', import.meta.url);
const ROOT = existsSync(fileURLToPath(BUNDLED)) ? BUNDLED : new URL('../share-viewer/', import.meta.url);

const read = (name: string) => readFileSync(new URL(name, ROOT), 'utf8');

const LOGO = read('logo.svg').trim();
const TEMPLATES = {
  login: read('login.html'),
  viewer: read('viewer.html'),
  ended: read('ended.html'),
};

/** The static files served next to the pages, by the name the pages request them under. */
export const SHARE_ASSETS: Record<string, { body: string; type: string }> = {
  'viewer.css': { body: read('viewer.css'), type: 'text/css; charset=utf-8' },
  'clipboard.js': { body: read('clipboard.js'), type: 'text/javascript; charset=utf-8' },
  'overlay.js': { body: read('overlay.js'), type: 'text/javascript; charset=utf-8' },
  'gestures.js': { body: read('gestures.js'), type: 'text/javascript; charset=utf-8' },
  'keys.js': { body: read('keys.js'), type: 'text/javascript; charset=utf-8' },
  'people.js': { body: read('people.js'), type: 'text/javascript; charset=utf-8' },
  'reconnect.js': { body: read('reconnect.js'), type: 'text/javascript; charset=utf-8' },
  'viewer.js': { body: read('viewer.js'), type: 'text/javascript; charset=utf-8' },
  'webrtc.js': { body: read('webrtc.js'), type: 'text/javascript; charset=utf-8' },
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Replaces each `{{name}}` with its escaped value; `{{logo}}` is the trusted wordmark file. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => (name === 'logo' ? LOGO : escape(values[name] ?? '')));
}

export function loginPage(message: string | null, app: string | null = null): string {
  return fill(TEMPLATES.login, { message: message ?? '', title: loginTitle(app) });
}

export function endedPage(): string {
  return fill(TEMPLATES.ended, {});
}

export function viewerPage(options: {
  title: string;
  control: boolean;
  /** The viewer can only watch a share that has control. */
  viewOnly: boolean;
  /** A view-only viewer is offered the control password. */
  upgrade: boolean;
  /** The share has no login, so the page asks for a name. */
  askName: boolean;
  platform: string;
  buttons: readonly string[];
  rotate: boolean;
}): string {
  return fill(TEMPLATES.viewer, {
    title: options.title,
    control: String(options.control),
    viewOnly: String(options.viewOnly),
    upgrade: String(options.upgrade),
    askName: String(options.askName),
    platform: options.platform,
    buttons: options.buttons.join(' '),
    rotate: String(options.rotate),
  });
}
