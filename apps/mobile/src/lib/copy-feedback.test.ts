import { COPIED_MS, createCopyFeedback } from './copy-feedback';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('returns to not copied after the delay', () => {
  const states: boolean[] = [];
  const feedback = createCopyFeedback((copied) => states.push(copied));
  feedback.start();
  jest.advanceTimersByTime(COPIED_MS - 1);
  expect(states).toEqual([true]);
  jest.advanceTimersByTime(1);
  expect(states).toEqual([true, false]);
});

test('a repeat copy restarts the wait and never stacks reverts', () => {
  const states: boolean[] = [];
  const feedback = createCopyFeedback((copied) => states.push(copied));
  feedback.start();
  jest.advanceTimersByTime(1500);
  feedback.start();
  jest.advanceTimersByTime(1500);
  expect(states).toEqual([true, true]);
  jest.advanceTimersByTime(500);
  expect(states).toEqual([true, true, false]);
  expect(jest.getTimerCount()).toBe(0);
});

test('cancel drops the pending revert', () => {
  const onChange = jest.fn();
  const feedback = createCopyFeedback(onChange);
  feedback.start();
  feedback.cancel();
  jest.advanceTimersByTime(COPIED_MS * 2);
  expect(onChange).toHaveBeenCalledTimes(1);
});
