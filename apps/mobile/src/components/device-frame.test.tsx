import 'react-native-unistyles/mocks';

import { render } from '@testing-library/react-native';
import { useEffect } from 'react';
import { View } from 'react-native';

import '@/design/unistyles';

import { DeviceFrame } from './device-frame';
import type { DeviceFrameArtwork } from '@/protocol/types';

jest.mock('expo-image', () => ({ Image: jest.requireActual<typeof import('react-native')>('react-native').View }));

const artwork: DeviceFrameArtwork = {
  width: 120,
  height: 240,
  aperture: { x: 10, y: 20, width: 100, height: 200 },
  cornerRadius: 12,
  quarterTurns: 0,
  background: 'png',
  foreground: 'png',
};

it('preserves the guest decoder when housing is enabled, rotated, or temporarily unavailable', async () => {
  let mounts = 0;
  let unmounts = 0;
  function Guest() {
    useEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);
    return <View />;
  }
  const guest = <Guest />;
  const screen = await render(<DeviceFrame artwork={null}>{guest}</DeviceFrame>);
  for (const value of [artwork, { ...artwork, quarterTurns: 2 }, null, artwork]) {
    await screen.rerender(<DeviceFrame artwork={value}>{guest}</DeviceFrame>);
  }
  expect(mounts).toBe(1);
  expect(unmounts).toBe(0);
  await screen.unmount();
  expect(unmounts).toBe(1);
});
