import { getHostComponent, NitroModules } from 'react-native-nitro-modules';
import type { HybridViewMethods } from 'react-native-nitro-modules';

import StimVideoViewConfig from '../nitrogen/generated/shared/json/StimVideoViewConfig.json';
import type { NoiseCheck, StimSession, StimVideoViewProps, VideoStream } from './specs/StimSession.nitro';

export type {
  FramingVector,
  NoiseVector,
  SessionClose,
  SessionOptions,
  StimSession,
  VideoFormat,
  VideoProgress,
  VideoStream,
} from './specs/StimSession.nitro';

export function createSession(): StimSession {
  return NitroModules.createHybridObject<StimSession>('StimSession');
}

/** A stream JavaScript feeds with `push`, for the development mock paths and tests only. */
export function createDevVideoStream(): VideoStream {
  if (!__DEV__) throw new Error('A JavaScript-fed VideoStream exists only in development builds.');
  return NitroModules.createHybridObject<VideoStream>('VideoStream');
}

export function createNoiseCheck(): NoiseCheck {
  return NitroModules.createHybridObject<NoiseCheck>('NoiseCheck');
}

export const StimVideoView = getHostComponent<StimVideoViewProps, HybridViewMethods>(
  'StimVideoView',
  () => StimVideoViewConfig,
);
