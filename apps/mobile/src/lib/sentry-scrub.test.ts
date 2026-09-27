import type { ErrorEvent } from '@sentry/react-native';

import { scrubBreadcrumb, scrubEvent, scrubText } from './sentry-scrub';

const DEVICE_TOKEN = 'q3N0cJ8bX1-_aZkLm2Vt9YwE4rPo6sHdUfGi7jKlMnA';
const UPDATE_ID = '0b5a2c1e-7f3d-4e8a-9c6b-1d2e3f4a5b6c';
const FINGERPRINT = '87cad17f256996c2023667c721a6115c4dcd0015';

describe('scrubText', () => {
  it.each([
    [
      'Cannot reach wss://janics-macbook.tail1a2b3.ts.net:7433. Check that Tailscale is connected on this phone.',
      'Cannot reach [url]. Check that Tailscale is connected on this phone.',
    ],
    [`hello with token ${DEVICE_TOKEN} failed`, 'hello with token [token] failed'],
    ['push token ExponentPushToken[xXxAbC123-_] registered', 'push token [push-token] registered'],
    ['connecting to janics-macbook.tail1a2b3.ts.net', 'connecting to [host]'],
    ['connecting to studio.local:7433', 'connecting to [host]:7433'],
    ['connecting to 100.101.102.103:7433', 'connecting to [ip]:7433'],
    ['/Users/janic/Developer/stim/apps/mobile', '~/Developer/stim/apps/mobile'],
  ])('scrubs %j', (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it('keeps update ids, fingerprints and ordinary error text', () => {
    const text = `update ${UPDATE_ID} on runtime ${FINGERPRINT}: undefined is not a function (App.tsx:12:31)`;
    expect(scrubText(text)).toBe(text);
  });
});

describe('scrubBreadcrumb', () => {
  it('scrubs the message and nested data', () => {
    expect(
      scrubBreadcrumb({
        category: 'console',
        message: 'Could not pair wss://mac.tail1a2b3.ts.net:7433 from .env.local',
        data: { arguments: ['wss://mac.tail1a2b3.ts.net:7433', { token: DEVICE_TOKEN }], logger: 'console' },
      }),
    ).toEqual({
      category: 'console',
      message: 'Could not pair [url] from .env.local',
      data: { arguments: ['[url]', { token: '[token]' }], logger: 'console' },
    });
  });
});

describe('scrubEvent', () => {
  it('scrubs messages, exception values, breadcrumbs, extra and the route context, and leaves tags alone', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: `pairing ${DEVICE_TOKEN}`,
      exception: { values: [{ type: 'Error', value: 'Cannot reach wss://mac.tail1a2b3.ts.net:7433.' }] },
      breadcrumbs: [{ category: 'navigation', data: { to: '/mac/abc/workspace?path=/Users/janic/app' } }],
      extra: { endpoint: 'wss://mac.tail1a2b3.ts.net:7433' },
      contexts: { route: { path: '/mac/abc/workspace', params: { path: '/Users/janic/app' } } },
      tags: { 'expo.updates.update_id': UPDATE_ID },
    };
    expect(scrubEvent(event)).toEqual({
      type: undefined,
      message: 'pairing [token]',
      exception: { values: [{ type: 'Error', value: 'Cannot reach [url].' }] },
      breadcrumbs: [{ category: 'navigation', data: { to: '/mac/abc/workspace?path=~/app' } }],
      extra: { endpoint: '[url]' },
      contexts: { route: { path: '/mac/abc/workspace', params: { path: '~/app' } } },
      tags: { 'expo.updates.update_id': UPDATE_ID },
    });
  });
});
