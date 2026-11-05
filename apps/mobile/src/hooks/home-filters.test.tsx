import { act, renderHook } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import type { ReactNode } from 'react';

import { HomeFiltersProvider, useHomeFilters } from './home-filters';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const wrapper = ({ children }: { children: ReactNode }) => <HomeFiltersProvider>{children}</HomeFiltersProvider>;

test('restores Archived at launch and saves later status selections', async () => {
  jest
    .mocked(SecureStore.getItemAsync)
    .mockImplementation(async (key) =>
      key === 'stim.homeFilters' ? JSON.stringify({ activity: 'archived', macs: ['mac'], projects: ['stim'] }) : null,
    );
  const { result } = await renderHook(useHomeFilters, { wrapper });
  expect(result.current.filters).toEqual({
    statuses: ['archived'],
    macs: ['mac'],
    projects: ['stim'],
    errorsOnly: false,
    remoteOnly: false,
    platforms: [],
    buildingOnly: false,
    sort: 'recent',
  });
  await act(async () => result.current.update({ statuses: ['live', 'idle', 'notSetUp', 'archived'] }));
  const saved = jest.mocked(SecureStore.setItemAsync).mock.calls.at(-1)!;
  expect(saved[0]).toBe('stim.homeFilters');
  expect(JSON.parse(saved[1])).toEqual({
    statuses: ['live', 'idle', 'notSetUp', 'archived'],
    macs: ['mac'],
    projects: ['stim'],
    errorsOnly: false,
    remoteOnly: false,
    platforms: [],
    buildingOnly: false,
    sort: 'recent',
  });
  await act(async () => result.current.update({ statuses: ['archived'] }));
  expect(JSON.parse(jest.mocked(SecureStore.setItemAsync).mock.calls.at(-1)![1]).statuses).toEqual(['archived']);
});
