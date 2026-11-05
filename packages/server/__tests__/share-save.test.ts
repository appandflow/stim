import assert from 'node:assert';
import { savedShareFor } from '../src/share-save.ts';
import type { ShareRequest, StartedShare } from '../src/share.ts';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const EXPIRES = '2026-11-05T12:00:00.000Z';
const NOW = new Date('2026-11-04T12:00:00.000Z');

const request = (over: Partial<ShareRequest> = {}): ShareRequest => ({
  workspace: '/work/app',
  platform: 'ios',
  control: false,
  expiresMinutes: 60,
  ...over,
});

const started = (over: Partial<StartedShare> = {}): StartedShare => ({
  id: 'w1',
  workspace: '/work/app',
  platform: 'ios',
  slot: 'default',
  physical: false,
  control: false,
  expiresAt: EXPIRES,
  viewers: 0,
  state: 'live',
  auth: 'generated',
  viewAuth: null,
  url: `https://mac.test/s/${TOKEN}/`,
  password: 'generated-pw-1',
  ...over,
});

describe('savedShareFor', () => {
  it('saves a generated password and the link token', () => {
    expect(savedShareFor(request(), started(), undefined, NOW)).toEqual({
      platform: 'ios',
      slot: 'default',
      physical: false,
      token: TOKEN,
      origin: 'https://mac.test/s/',
      control: false,
      password: 'generated-pw-1',
      auth: 'generated',
      viewAuth: null,
      state: 'live',
      createdAt: NOW.toISOString(),
      expiresAt: EXPIRES,
    });
  });

  it('saves the password the person set, the view password, the slot and the device', () => {
    const entry = savedShareFor(
      request({
        password: 'chosen-pw-1',
        view: {},
        control: true,
        slot: 'tablet',
        physical: true,
        platform: 'android',
      }),
      started({ auth: 'set', password: undefined, viewAuth: 'generated', viewPassword: 'view-pw-gen', control: true }),
      undefined,
      NOW,
    );
    expect(entry).toMatchObject({
      platform: 'android',
      slot: 'tablet',
      physical: true,
      password: 'chosen-pw-1',
      viewPassword: 'view-pw-gen',
      auth: 'set',
      viewAuth: 'generated',
      control: true,
    });
  });

  it('saves an open share without a password, and a slug share under its slug', () => {
    expect(
      savedShareFor(request({ passwordless: true }), started({ auth: 'none', password: undefined }), undefined, NOW),
    ).not.toHaveProperty('password');
    const slugged = savedShareFor(
      request({ slug: 'pokedex', password: 'chosen-pw-1' }),
      started({ auth: 'set', password: undefined, slug: 'pokedex', url: 'https://mac.test/s/pokedex/' }),
      undefined,
      NOW,
    );
    expect(slugged).toMatchObject({ slug: 'pokedex', origin: 'https://mac.test/s/' });
    expect(slugged).not.toHaveProperty('token');
  });

  it('keeps how the passwords were made and when the link began when the same link starts again with them', () => {
    const first = savedShareFor(request(), started(), undefined, NOW);
    assert(first);
    const later = new Date(NOW.getTime() + 60_000);
    const again = savedShareFor(
      request({ token: TOKEN, password: 'generated-pw-1' }),
      started({ auth: 'set', password: undefined, expiresAt: '2026-11-05T13:00:00.000Z' }),
      first,
      later,
    );
    expect(again).toMatchObject({
      auth: 'generated',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-11-05T13:00:00.000Z',
    });
    const changed = savedShareFor(
      request({ token: TOKEN, password: 'another-pw-1' }),
      started({ auth: 'set', password: undefined }),
      first,
      later,
    );
    expect(changed).toMatchObject({ auth: 'set', createdAt: later.toISOString(), password: 'another-pw-1' });
  });

  it('saves nothing when the link or a needed password is not known', () => {
    expect(savedShareFor(request(), started({ url: 'https://mac.test/elsewhere' }), undefined, NOW)).toBeNull();
    expect(savedShareFor(request(), started({ password: undefined }), undefined, NOW)).toBeNull();
    expect(
      savedShareFor(
        request({ control: true, view: {} }),
        started({ control: true, viewAuth: 'generated' }),
        undefined,
        NOW,
      ),
    ).toBeNull();
  });
});
