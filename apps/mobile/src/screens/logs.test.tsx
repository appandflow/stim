import 'react-native-unistyles/mocks';

import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState } from 'react-native';

import '@/design/unistyles';

import type { LogEntry } from '@/lib/logs';
import type { LogFilter, LogRecord, ServerEvent } from '@/protocol/types';

import { Logs } from './logs';

let mockFocused = true;
const mockSubscriptions: {
  filter: LogFilter;
  event: (event: ServerEvent) => void;
  reset: () => void;
  stop: jest.Mock;
}[] = [];
const mockConnection = {
  subscribe: jest.fn((_method: string, filter: LogFilter, event: (event: ServerEvent) => void, reset: () => void) => {
    const stop = jest.fn();
    mockSubscriptions.push({ filter, event, reset, stop });
    return stop;
  }),
  request: jest.fn(),
};
let mockEntries: LogEntry[] = [];

jest.mock('expo-router', () => ({ Stack: { Screen: () => null }, useIsFocused: () => mockFocused }));
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  Object.defineProperty(native, 'AppState', {
    value: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    configurable: true,
  });
  return native;
});
jest.mock('@/hooks/machines', () => ({
  useMacConnection: () => ({ connection: mockConnection, state: { kind: 'open' }, home: null }),
  useStatus: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/components/connection-banner', () => ({ ConnectionBanner: () => null }));
jest.mock('@/components/header-title', () => ({ HeaderTitle: () => null }));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/platform-logo', () => ({ PlatformLogo: () => null }));
jest.mock('@/components/pill', () => ({ StatusDot: () => null }));
jest.mock('@/components/text', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}));
jest.mock('@/components/touch', () => ({
  Touch: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));
jest.mock('@/components/lists', () => ({
  ScrollView: jest.requireActual<typeof import('react-native')>('react-native').ScrollView,
  FlatList: ({ data, ListHeaderComponent }: { data: LogEntry[]; ListHeaderComponent: React.ReactNode }) => {
    mockEntries = data;
    const { View } = jest.requireActual('react-native');
    return <View>{ListHeaderComponent}</View>;
  },
}));

const body = (at?: string) => (
  <I18nProvider i18n={i18n}>
    <Logs path="/app" params={{ at }} />
  </I18nProvider>
);
const record = (ts: number): LogRecord => ({ ts, src: 'client', level: 'info', msg: `record ${ts}` });
const latest = () => mockSubscriptions.at(-1)!;
const push = async (records: LogRecord[]) =>
  act(async () => latest().event({ event: 'logs', subscription: 's', records }));

beforeEach(() => {
  mockFocused = true;
  mockEntries = [];
  mockSubscriptions.length = 0;
  jest.clearAllMocks();
  jest.replaceProperty(AppState, 'currentState', 'active');
});
afterEach(() => jest.restoreAllMocks());

test('starts with 200 records and explicitly reloads an older recent window without duplicating overlap', async () => {
  const screen = await render(body());
  expect(latest().filter.tail).toBe(200);
  await push(Array.from({ length: 200 }, (_, i) => record(i + 201)));
  await fireEvent.press(screen.getByLabelText('Load older logs'));
  expect(mockSubscriptions[0]!.stop).toHaveBeenCalledTimes(1);
  expect(latest().filter.tail).toBe(400);
  await push(Array.from({ length: 400 }, (_, i) => record(i + 1)));
  expect(mockEntries.map((entry) => entry.lead.ts)).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
  await push([record(401)]);
  expect(mockEntries).toHaveLength(401);
  expect(mockSubscriptions).toHaveLength(2);
});

test('unsubscribes while covered and backgrounded, retains the display window, and ignores late callbacks', async () => {
  let change: ((state: 'active' | 'background') => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    change = listener;
    return { remove: jest.fn() };
  });
  const screen = await render(body());
  await push(Array.from({ length: 240 }, (_, i) => record(i + 1)));
  const previous = latest();
  mockFocused = false;
  await screen.rerender(body());
  expect(previous.stop).toHaveBeenCalledTimes(1);
  await act(async () => {
    previous.event({ event: 'logs', subscription: 's', records: [record(999)] });
    previous.reset();
  });
  expect(mockEntries).toHaveLength(240);
  expect(mockSubscriptions).toHaveLength(1);
  mockFocused = true;
  await screen.rerender(body());
  expect(latest().filter.tail).toBe(240);
  await push(Array.from({ length: 240 }, (_, i) => record(i + 41)));
  expect(mockEntries.map((entry) => entry.lead.ts)).toEqual(Array.from({ length: 240 }, (_, i) => i + 41));
  await act(async () => change!('background'));
  expect(latest().stop).toHaveBeenCalledTimes(1);
  const count = mockSubscriptions.length;
  await screen.rerender(body());
  expect(mockSubscriptions).toHaveLength(count);
  await act(async () => change!('active'));
  expect(mockSubscriptions).toHaveLength(count + 1);
  expect(latest().filter.tail).toBe(240);
});

test('does not subscribe until a covered route becomes focused', async () => {
  mockFocused = false;
  const screen = await render(body());
  expect(mockSubscriptions).toHaveLength(0);
  mockFocused = true;
  await screen.rerender(body());
  expect(latest().filter.tail).toBe(200);
});

test('reconnect replaces the current display window and preserves distinct equal-time records', async () => {
  await render(body());
  await push(Array.from({ length: 240 }, (_, i) => record(i)));
  await act(async () => latest().reset());
  expect(latest().filter.tail).toBe(240);
  const records = [record(1), { ...record(1), msg: 'another record at the same time' }];
  await push(records);
  expect(mockEntries.map((entry) => entry.key)).toEqual(['1:0', '1:1']);
  expect(mockEntries.map((entry) => entry.lead.msg)).toEqual(records.map((item) => item.msg));
});

test('keeps the larger deep-link window and attached error context', async () => {
  await render(body('12'));
  expect(latest().filter.tail).toBe(5000);
  const failure: LogRecord = {
    ts: 12,
    src: 'metro',
    level: 'error',
    event: 'expo_stdout',
    raw: true,
    msg: 'App.js: Broken expression',
    context: ['> 12 | broken', '     | ^'],
  };
  await push([failure]);
  expect(mockEntries[0]!.key).toBe('12:0');
  expect(mockEntries[0]!.context).toEqual(failure.context);
});

test('regroups a bundle failure when the older window brings back its marker', async () => {
  const screen = await render(body());
  const all: LogRecord[] = [
    { ts: 1, src: 'metro', level: 'error', raw: true, event: 'expo_stdout', marker: true, msg: 'iOS Bundling failed' },
    { ts: 2, src: 'metro', level: 'error', raw: true, event: 'expo_stdout', msg: 'SyntaxError: broken expression' },
    { ts: 3, src: 'metro', level: 'info', raw: true, event: 'expo_stdout', msg: '> 12 | broken' },
    { ts: 4, src: 'metro', level: 'error', event: 'bundle_response_failed', platform: 'ios', msg: 'Bundle failed' },
    ...Array.from({ length: 197 }, (_, i) => record(i + 5)),
  ];
  await push(all.slice(-200));
  await fireEvent.press(screen.getByLabelText('Load older logs'));
  await push(all);
  expect(mockEntries).toHaveLength(198);
  expect(mockEntries[0]!.lead.msg).toBe('SyntaxError: broken expression');
  expect(mockEntries[0]!.related.map((item) => item.msg)).toEqual(['iOS Bundling failed', 'Bundle failed']);
  expect(mockEntries[0]!.context).toEqual(['> 12 | broken']);
});

test('keeps the newest 5,000 live records and removes older loading at the request cap', async () => {
  const screen = await render(body());
  await push(Array.from({ length: 5_100 }, (_, i) => record(i)));
  expect(mockEntries).toHaveLength(5_000);
  expect(mockEntries[0]!.lead.ts).toBe(100);
  await fireEvent.press(screen.getByLabelText('Load older logs'));
  expect(latest().filter.tail).toBe(5_000);
  await push(Array.from({ length: 5_000 }, (_, i) => record(i + 100)));
  expect(mockEntries).toHaveLength(5_000);
  expect(screen.queryByLabelText('Load older logs')).toBeNull();
});
