import {
  bugReportUrl,
  diagnosticText,
  shortId,
  versionWithBuild,
  type AboutApp,
  type AboutDevice,
  type AboutMachine,
} from '@/lib/about';

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
        { name: 'MacBook Pro', detail: { stim: '1.14.0', server: '1.14.0', protocol: 1 } },
        { name: 'Mac mini', detail: { state: 'Needs an update' } },
      ]),
    ).toBe(
      [
        'Stim for phones 0.1.0 (12) (ios)',
        'Runtime version: 0.1.0',
        'Channel: production',
        'Update: 01a0f251-5fa5-7d78-bafd-b77f915d8900 (published 2026-09-30T13:15:00.000Z)',
        'Protocol: 1',
        'MacBook Pro: stim 1.14.0, server 1.14.0, protocol 1',
        'Mac mini: Needs an update',
      ].join('\n'),
    );
  });

  it('reports a built-in launch without an update id', () => {
    const text = diagnosticText({ ...app, embedded: true, channel: null, runtimeVersion: null }, []);
    expect(text).toContain('Update: built-in');
    expect(text).toContain('Channel: none');
  });

  describe('bugReportUrl', () => {
    const device: AboutDevice = { os: 'ios', osVersion: '27.0', model: 'iPhone 18 Pro', locale: 'en-CA' };
    const machine = (name: string, patch: Partial<AboutMachine> = {}): AboutMachine => ({
      name,
      detail: { stim: '1.14.0', server: '1.14.0', protocol: 1 },
      ...patch,
    });
    const parse = (url: string) => {
      const parsed = new URL(url);
      return { url: parsed, title: parsed.searchParams.get('title'), body: parsed.searchParams.get('body') ?? '' };
    };

    it('opens the report template with the mobile title prefix and its headings', () => {
      const { url, title, body } = parse(bugReportUrl(app, [], device));
      expect(url.origin + url.pathname).toBe('https://github.com/appandflow/stim/issues/new');
      expect(url.searchParams.get('template')).toBe('report.md');
      expect(title).toBe('mobile: ');
      expect(body.match(/^## .*$/gm)).toEqual(['## Problem', '## Evidence', '## Cause', '## Fix idea']);
      expect(body).toContain('- App: Stim for phones 0.1.0 (12) (ios)');
      expect(body).toContain('- OS: iOS 27.0');
      expect(body).toContain('- Locale: en-CA');
    });

    it('numbers machines and leaves out their names', () => {
      const url = bugReportUrl(
        app,
        [machine("Janic's MacBook Pro"), machine('mini.tail1234.ts.net', { detail: { state: 'Offline' } })],
        device,
      );
      const { body } = parse(url);
      expect(body).toContain('- Machine 1: stim 1.14.0, server 1.14.0, protocol 1');
      expect(body).toContain('- Machine 2: Offline');
      expect(url).not.toMatch(/Janic|MacBook|tail1234|ts\.net/);
    });

    it('keeps the URL under the cap and counts the machines it drops', () => {
      const many = Array.from({ length: 400 }, (_, index) => machine(`Mac ${index}`));
      const url = bugReportUrl(app, many, device);
      expect(url.length).toBeLessThanOrEqual(7000);
      expect(parse(url).body).toMatch(/- \d+ more machines/);
    });
  });
});
