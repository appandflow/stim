import { act, renderHook } from '@testing-library/react-native';

import { RequestError } from '@/lib/connection';
import { useArchiveDetail } from './archive-detail';

const mockConnection = { request: jest.fn() };
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('@/hooks/app-foreground', () => ({ useAppForeground: () => true }));
jest.mock('@/hooks/machines', () => ({
  useMacConnection: () => ({ connection: mockConnection, state: { kind: 'open' } }),
}));

test('loads closed archive history once and retains the summary fallback on an older server refusal', async () => {
  jest.useFakeTimers();
  try {
    mockConnection.request.mockRejectedValue(new RequestError({ code: 'unknown-method', message: 'Unknown method' }));
    const { result } = await renderHook(() => useArchiveDetail('old'));
    await act(async () => {});
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeInstanceOf(RequestError);
    await act(async () => jest.advanceTimersByTime(30000));
    expect(mockConnection.request).toHaveBeenCalledTimes(1);
    expect(mockConnection.request).toHaveBeenCalledWith('archive.detail', { archive: 'old' });
  } finally {
    jest.useRealTimers();
  }
});
