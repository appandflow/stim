import { welcomeState } from '@/lib/welcome';

it('shows the welcome on first launch with no saved Mac', () => {
  expect(welcomeState([], false)).toEqual({ show: true, markSeen: false });
});

it('hides the welcome after Not now', () => {
  expect(welcomeState([], true)).toEqual({ show: false, markSeen: false });
});

it('counts a saved Mac as completing the welcome', () => {
  expect(welcomeState([{}], false)).toEqual({ show: false, markSeen: true });
  expect(welcomeState([{}], true)).toEqual({ show: false, markSeen: true });
});

it.each([null, undefined])('does not show or mark the welcome while Macs are loading (%s)', (macs) => {
  expect(welcomeState(macs, false)).toEqual({ show: false, markSeen: false });
  expect(welcomeState(macs, true)).toEqual({ show: false, markSeen: false });
});
