import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';

import { Text } from 'react-native';
import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import '@/design/unistyles';

import { RouteErrorBoundary } from '@/components/route-error-boundary';

// expo-router/testing-library swaps Reanimated for this mock, which fails to load under Reanimated 4.7. Touch needs only this hook.
jest.mock('react-native-reanimated/mock', () => ({
  __esModule: true,
  default: {
    call: () => {},
    createAnimatedComponent: (component: unknown) => component,
  },
  useReducedMotion: () => true,
}));

jest.mock('@sentry/react-native', () => ({
  wrapExpoRouterErrorBoundary: (Fallback: unknown) => Fallback,
}));

let payload: { name?: string } | undefined;

function Screen() {
  return <Text>{payload!.name!.toUpperCase()}</Text>;
}

const routes = {
  index: () => <Text>home</Text>,
  'mac/[id]/index': { default: Screen, ErrorBoundary: RouteErrorBoundary },
};

afterEach(() => jest.restoreAllMocks());

it('shows the error in place of the crashing screen and retries it', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  payload = undefined;
  await renderRouter(routes, { initialUrl: '/mac/m1' });
  expect(screen.getByText('This screen could not be shown')).toBeTruthy();
  expect(screen.getByText('Try again')).toBeTruthy();

  payload = { name: 'ok' };
  await fireEvent.press(screen.getByText('Try again'));
  expect(screen.getByText('OK')).toBeTruthy();
});

it('goes back to the previous route', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  payload = undefined;
  await renderRouter(routes, { initialUrl: '/' });
  await act(() => router.push('/mac/m1'));
  expect(screen.getByText('This screen could not be shown')).toBeTruthy();

  await fireEvent.press(screen.getByText('Back'));
  expect(screen.getByText('home')).toBeTruthy();
  expect(screen.queryByText('This screen could not be shown')).toBeNull();
});
