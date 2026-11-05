import { act, render, screen } from '@testing-library/react-native';
import { useContext } from 'react';
import { Platform, RootTagContext, Text, type RootTag } from 'react-native';

jest.mock('react-native-screens/src/components/ScreenContentWrapper', () => ({
  __esModule: true,
  default: jest.requireActual('react-native').View,
}));

const DebugContainer = jest.requireActual('react-native-screens/src/components/DebugContainer')
  .default as React.ComponentType<React.PropsWithChildren<{ stackPresentation: 'transparentModal' }>>;

beforeEach(() => jest.useFakeTimers());

afterEach(async () => {
  await act(() => jest.runOnlyPendingTimersAsync());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function RootReading() {
  return <Text testID="root-tag">{String(useContext(RootTagContext))}</Text>;
}

it.each(['ios', 'android'] as const)('preserves the React root tag inside a %s transparent modal', async (platform) => {
  jest.replaceProperty(Platform, 'OS', platform);
  await render(
    <RootTagContext.Provider value={41 as unknown as RootTag}>
      <DebugContainer stackPresentation="transparentModal">
        <RootReading />
      </DebugContainer>
    </RootTagContext.Provider>,
  );
  expect(screen.getByTestId('root-tag')).toHaveTextContent('41');
});
