import { Image } from 'expo-image';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { DeviceFrameArtwork } from '@/protocol/types';

/** Places the existing guest screen and its input overlay in the installed housing's aperture. */
export function DeviceFrame({ artwork, children }: { artwork: DeviceFrameArtwork | null; children: ReactNode }) {
  const [width, setWidth] = useState(0);
  const aperture = artwork?.aperture;
  return (
    <View style={StyleSheet.absoluteFill} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {artwork ? (
        <Image
          pointerEvents="none"
          recyclingKey={`${artwork.quarterTurns}/${artwork.width}x${artwork.height}`}
          source={{ uri: `data:image/png;base64,${artwork.background}` }}
          style={StyleSheet.absoluteFill}
          contentFit="fill"
          transition={0}
        />
      ) : null}
      <View
        key="guest"
        style={
          artwork && aperture
            ? {
                position: 'absolute',
                left: `${(100 * aperture.x) / artwork.width}%`,
                top: `${(100 * aperture.y) / artwork.height}%`,
                width: `${(100 * aperture.width) / artwork.width}%`,
                height: `${(100 * aperture.height) / artwork.height}%`,
                borderRadius: (artwork.cornerRadius * width) / artwork.width,
                overflow: 'hidden',
              }
            : StyleSheet.absoluteFill
        }
      >
        {children}
      </View>
      {artwork ? (
        <Image
          pointerEvents="none"
          recyclingKey={`${artwork.quarterTurns}/${artwork.width}x${artwork.height}`}
          source={{ uri: `data:image/png;base64,${artwork.foreground}` }}
          style={StyleSheet.absoluteFill}
          contentFit="fill"
          transition={0}
        />
      ) : null}
    </View>
  );
}
