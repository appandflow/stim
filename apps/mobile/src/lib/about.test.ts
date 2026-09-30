import { diagnosticText, shortId, versionWithBuild, type AboutApp } from '@/lib/about';

const app: AboutApp = {
  version: '0.1.0',
  build: '12',
  platform: 'ios',
  runtimeVersion: '0.1.0',
  channel: 'production',
  updateId: '01a0f251-5fa5-7d78-bafd-b77f915d8900',
  updatedAt: new Date('2026-09-30T13:15:00.000Z'),
  embedded: false,
  protocol: 1,
};

describe('about', () => {
  it('appends the build number only when the app has one', () => {
    expect(versionWithBuild(app)).toBe('0.1.0 (12)');
    expect(versionWithBuild({ ...app, build: null })).toBe('0.1.0');
  });

  it('shortens an id to its first 8 characters', () => {
    expect(shortId(app.updateId!)).toBe('01a0f251');
    expect(shortId('0.1.0')).toBe('0.1.0');
  });

  it('lists every version, and what keeps a machine from reporting its own', () => {
    expect(
      diagnosticText(app, [
        { name: 'MacBook Pro', detail: { stim: '1.14.0', server: '1.14.0' } },
        { name: 'Mac mini', detail: { state: 'Needs an update' } },
      ]),
    ).toBe(
      [
        'Stim for phones 0.1.0 (12) (ios)',
        'Runtime version: 0.1.0',
        'Channel: production',
        'Update: 01a0f251-5fa5-7d78-bafd-b77f915d8900 (published 2026-09-30T13:15:00.000Z)',
        'Protocol: 1',
        'MacBook Pro: stim 1.14.0, server 1.14.0',
        'Mac mini: Needs an update',
      ].join('\n'),
    );
  });

  it('reports a built-in launch without an update id', () => {
    const text = diagnosticText({ ...app, embedded: true, channel: null, runtimeVersion: null }, []);
    expect(text).toContain('Update: built-in');
    expect(text).toContain('Channel: none');
  });
});
