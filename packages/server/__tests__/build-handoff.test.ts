import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildHost } from '../src/build.ts';

test('retains a fetched iOS simulator bundle for its client and digest once, then deletes it on release', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-build-handoff-'));
  process.env.STIM_HOME = home;
  const host = new BuildHost({ worker: 'unused', env: process.env });
  try {
    const out = join(home, 'out');
    const bundle = join(out, 'Fixture.app');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'Info.plist'), 'verified plist');
    const archive = join(out, 'app.tgz');
    writeFileSync(archive, 'archive bytes');
    const digest = createHash('sha256').update('archive bytes').digest('hex');
    const token = host.retain({ client: 'builder', platform: 'ios', archive } as Parameters<BuildHost['retain']>[0], {
      name: 'Fixture.app',
      sha256: digest,
      size: 13,
    });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(archive)).toBe(false);
    expect(typeof host.takeBundle(token!, 'a'.repeat(64), () => true)).toBe('string');
    expect(typeof host.takeBundle(token!, digest, () => false)).toBe('string');
    const taken = host.takeBundle(token!, digest, (client) => client === 'builder');
    if (typeof taken === 'string') throw new Error(taken);
    expect(readFileSync(join(taken.bundle, 'Info.plist'), 'utf8')).toBe('verified plist');
    expect(typeof host.takeBundle(token!, digest, () => true)).toBe('string');
    taken.release();
    expect(existsSync(out)).toBe(false);
  } finally {
    await host.close();
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
