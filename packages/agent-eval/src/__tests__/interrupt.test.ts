import { EventEmitter } from 'node:events';
import { expect, test } from 'vitest';
import { trapSignals } from '../interrupt.ts';

test('the first signal aborts and is reported, the second exits at once with its own status', () => {
  const target = new EventEmitter();
  const exits: number[] = [];
  const trap = trapSignals(target, (code) => exits.push(code));
  target.emit('SIGINT');
  expect(trap.signal.aborted).toBe(true);
  expect(trap.received()).toBe(130);
  expect(exits).toEqual([]);
  target.emit('SIGTERM');
  expect(exits).toEqual([143]);
});

test('releasing the trap leaves later signals to their default', () => {
  const target = new EventEmitter();
  trapSignals(target, () => undefined).release();
  expect(target.listenerCount('SIGINT') + target.listenerCount('SIGTERM')).toBe(0);
});
