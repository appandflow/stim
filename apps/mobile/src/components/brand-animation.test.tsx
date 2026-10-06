import { render, screen } from '@testing-library/react-native';

import { BrandAnimation } from './brand-animation';

let mockReducedMotion = false;
const mockResume = jest.fn();
const mockReset = jest.fn();

jest.mock('react-native-reanimated', () => ({ useReducedMotion: () => mockReducedMotion }));
jest.mock('lottie-react-native', () => {
  const { forwardRef, useImperativeHandle } = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return forwardRef((props: object, ref) => {
    useImperativeHandle(ref, () => ({ resume: mockResume, reset: mockReset }));
    return <View {...props} testID="animation" />;
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReducedMotion = false;
});

test('Reduce Motion prevents playback and restores the resting frame when enabled', async () => {
  mockReducedMotion = true;
  const { rerender } = await render(<BrandAnimation name="device-boot-ios" playing />);
  expect(screen.getByTestId('animation', { includeHiddenElements: true }).props.autoPlay).toBe(false);
  expect(screen.getByTestId('animation', { includeHiddenElements: true }).props.progress).toBe(0);
  expect(mockResume).not.toHaveBeenCalled();
  expect(mockReset).toHaveBeenCalledTimes(1);

  mockReducedMotion = false;
  await rerender(<BrandAnimation name="device-boot-ios" playing />);
  expect(screen.getByTestId('animation', { includeHiddenElements: true }).props.autoPlay).toBe(true);
  expect(screen.getByTestId('animation', { includeHiddenElements: true }).props.progress).toBeUndefined();
  expect(mockResume).toHaveBeenCalledTimes(1);

  mockReducedMotion = true;
  await rerender(<BrandAnimation name="device-boot-ios" playing />);
  expect(screen.getByTestId('animation', { includeHiddenElements: true }).props.autoPlay).toBe(false);
  expect(screen.getByTestId('animation', { includeHiddenElements: true }).props.progress).toBe(0);
  expect(mockReset).toHaveBeenCalledTimes(2);
  expect(mockResume).toHaveBeenCalledTimes(1);
});

test('leaving a focused placement pauses playback at the resting frame', async () => {
  const { rerender } = await render(<BrandAnimation name="device-boot-ios" playing />);
  expect(mockResume).toHaveBeenCalledTimes(1);

  await rerender(<BrandAnimation name="device-boot-ios" playing={false} />);
  expect(mockReset).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('animation', { includeHiddenElements: true }).props.autoPlay).toBe(false);
  expect(screen.getByTestId('animation', { includeHiddenElements: true }).props.progress).toBe(0);

  await rerender(<BrandAnimation name="device-boot-ios" playing />);
  expect(mockResume).toHaveBeenCalledTimes(2);
});
