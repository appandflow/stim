import type { NetworkInterfaceInfo } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { localTransport, resolveLanAddresses } from '../index.ts';

afterEach(() => vi.useRealTimers());

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});
const v6 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: `${address}/64`,
  scopeid: 0,
});

const interfaces = {
  lo0: [v4('127.0.0.1', true)],
  en0: [v4('10.0.0.92'), v6('fe80::1')],
  en1: [v4('203.0.113.7')],
  utun4: [v4('100.101.1.2')],
};

test('listens only on private IPv4 addresses an interface holds, never on a wildcard, loopback or public address', () => {
  expect(
    resolveLanAddresses(
      ['en0', '0.0.0.0', '::', '127.0.0.1', '203.0.113.7', 'en1', 'utun4', '192.168.1.5', 'en9', 'lo0'],
      interfaces,
    ),
  ).toEqual({
    addresses: ['10.0.0.92'],
    problems: [
      '0.0.0.0 is not a private local network address (10/8, 172.16/12, 192.168/16 or 169.254/16)',
      ':: is neither an IPv4 address nor a network interface name',
      '127.0.0.1 is not a private local network address (10/8, 172.16/12, 192.168/16 or 169.254/16)',
      '203.0.113.7 is not a private local network address (10/8, 172.16/12, 192.168/16 or 169.254/16)',
      'en1 has no private IPv4 address now',
      'utun4 has no private IPv4 address now',
      'no network interface has 192.168.1.5 now',
      'no network interface is named en9 now',
      'lo0 has no private IPv4 address now',
    ],
  });
});

test('watch reports a changed setting or lease on the next poll, and stays quiet while nothing changes', () => {
  vi.useFakeTimers();
  let entries = ['en0'];
  let current: Record<string, NetworkInterfaceInfo[]> = { en0: [v4('10.0.0.92')] };
  const transport = localTransport({ entries: () => entries, interfaces: () => current, pollMs: 1000 });
  const listener = vi.fn<() => void>();
  const stop = transport.watch(listener);
  vi.advanceTimersByTime(3000);
  expect(listener).not.toHaveBeenCalled();
  current = { en0: [v4('10.0.0.93')] };
  vi.advanceTimersByTime(1000);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(transport.bindAddresses()).toEqual(['10.0.0.93']);
  entries = [];
  vi.advanceTimersByTime(1000);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(transport.bindAddresses()).toEqual([]);
  stop();
  entries = ['en0'];
  vi.advanceTimersByTime(5000);
  expect(listener).toHaveBeenCalledTimes(2);
});
