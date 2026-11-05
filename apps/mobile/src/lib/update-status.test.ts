import { updateStatus } from '@/lib/update-status';

it.each([
  [true, true, true, 'ready'],
  [false, false, true, 'ready'],
  [true, true, false, 'downloading'],
  [false, true, false, 'downloading'],
  [true, false, false, 'checking'],
  [false, false, false, null],
] as const)(
  'shows %s checking, %s downloading, %s pending as %s',
  (isChecking, isDownloading, isUpdatePending, expected) => {
    expect(updateStatus({ isChecking, isDownloading, isUpdatePending })).toBe(expected);
  },
);
