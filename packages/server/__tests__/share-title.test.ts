import { describe, expect, it } from 'vitest';
import type { StatusPayload } from '@stim-cli/core/state';
import { androidModel, cleanTitleText, deviceModel, loginTitle, titleFacts, viewerTitle } from '../src/share-title.ts';

const dot = String.fromCharCode(0xb7);
const bidi = String.fromCharCode(0x202e);
const request = { workspace: '/work/app', platform: 'ios', slot: undefined, physical: undefined } as const;
const status = (ios: Record<string, unknown>): StatusPayload =>
  JSON.parse(JSON.stringify({ environments: [{ path: '/work/app', ios }] }));

describe('the share page titles', () => {
  it('takes the model from an owned simulator name without the Stim label and the runtime version', () => {
    expect(deviceModel('stim-feature-x (iPhone 18 Pro 27.0)')).toBe('iPhone 18 Pro');
    expect(deviceModel('stim-app (iPhone 17)')).toBe('iPhone 17');
    expect(deviceModel('stim-x (iPad Air 13-inch (M3) 27.0)')).toBe('iPad Air 13-inch (M3)');
    expect(deviceModel('stim-x (iPhone SE (3rd generation) 18.0)')).toBe('iPhone SE (3rd generation)');
    expect(deviceModel('iPad Air 13-inch (M3) 18.2')).toBe('iPad Air 13-inch (M3)');
    expect(deviceModel('stim-secret-project')).toBeNull();
    expect(deviceModel(undefined)).toBeNull();
  });

  it('turns an AVD device profile into a model and ignores anything else', () => {
    expect(androidModel('pixel_8')).toBe('Pixel 8');
    expect(androidModel('Pixel 8; drop table')).toBeNull();
    expect(androidModel(null)).toBeNull();
  });

  it('cleans what an app calls itself: one line, no control or bidi characters, at most 60 characters', () => {
    expect(cleanTitleText(`  My${bidi}\n App\t `)).toBe('My App');
    expect(cleanTitleText('a'.repeat(80))).toHaveLength(60);
    expect(cleanTitleText(`\u0000${bidi} `)).toBeNull();
    expect(cleanTitleText(7)).toBeNull();
  });

  it('builds the viewer and login titles, with a generic fallback', () => {
    expect(viewerTitle('ios', 'Pokedex', 'iPhone 18 Pro')).toBe(`Pokedex ${dot} iPhone 18 Pro ${dot} Stim`);
    expect(viewerTitle('android', null, null)).toBe(`Live Android app ${dot} Stim`);
    expect(loginTitle('Pokedex')).toBe(`Pokedex ${dot} Stim`);
    expect(loginTitle(null)).toBe(`Shared app ${dot} Stim`);
  });

  it('reads the app id only while the app runs, and nothing for a physical or missing device', () => {
    const ios = { name: 'stim-x (iPhone 18 Pro 27.0)', app: { id: 'dev.app', state: 'running' } };
    expect(titleFacts(status(ios), request)).toEqual({ appId: 'dev.app', model: 'iPhone 18 Pro' });
    expect(titleFacts(status({ ...ios, app: { id: 'dev.app', state: 'stopped' } }), request).appId).toBeNull();
    expect(titleFacts(status(ios), { ...request, physical: true })).toEqual({ appId: null, model: null });
    expect(titleFacts(null, request)).toEqual({ appId: null, model: null });
  });
});
