import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { unmetNodePin, withProjectNode } from '../supervisor/project-node.ts';

describe('project Node pins', () => {
  let dir: string;
  let app: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const nvm = (version: string) => {
    const bin = join(dir, 'home', '.nvm', 'versions', 'node', version, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), '');
    return bin;
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-project-node-'));
    app = join(dir, 'repo', 'apps', 'mobile');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(dir, 'repo', '.nvmrc'), '1.2.0\n');
    process.env.HOME = process.env.USERPROFILE = join(dir, 'home');
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const top = () => join(dir, 'repo');

  it('puts the newest same-major install not older than an uninstalled pin first, unless PATH already fits it', () => {
    nvm('v1.1.0');
    const bin = nvm('v1.3.0');
    const env = { PATH: '/usr/bin' };
    const switched = withProjectNode(app, env, { top: top(), nodeVersion: () => '2.0.0' });
    expect(switched.env.PATH).toBe([bin, '/usr/bin'].join(delimiter));
    expect(switched.pinned).toMatchObject({ version: '1.3.0', match: 'major' });
    expect(withProjectNode(app, env, { top: top(), nodeVersion: () => '1.4.0' })).toEqual({ env, pinned: null });
    expect(withProjectNode(app, env, { top: top(), nodeVersion: () => '1.1.5' }).env.PATH).toBe(
      [bin, '/usr/bin'].join(delimiter),
    );
  });

  it('names the pin and the node on PATH only when neither an install nor PATH fits the pin', () => {
    nvm('v1.1.0');
    expect(unmetNodePin(app, {}, { top: top(), nodeVersion: () => '26.7.0' })).toBe(
      'Node 26.7.0 on PATH does not satisfy .nvmrc 1.2.0, and no installed Node does.',
    );
    expect(unmetNodePin(app, {}, { top: top(), nodeVersion: () => '1.5.0' })).toBeNull();
  });
});
