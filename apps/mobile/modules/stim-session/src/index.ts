import { getHostComponent, NitroModules } from 'react-native-nitro-modules';
import type { HybridViewMethods } from 'react-native-nitro-modules';

import StimVideoViewConfig from '../nitrogen/generated/shared/json/StimVideoViewConfig.json';
import type { NoiseCheck, StimSession, StimVideoViewProps } from './specs/StimSession.nitro';

export type {
  SessionClose,
  SessionTiming,
  StimSession,
  VideoFormat,
  VideoProgress,
  VideoStream,
} from './specs/StimSession.nitro';

export function createSession(): StimSession {
  return NitroModules.createHybridObject<StimSession>('StimSession');
}

export function createNoiseCheck(): NoiseCheck {
  return NitroModules.createHybridObject<NoiseCheck>('NoiseCheck');
}

export const StimVideoView = getHostComponent<StimVideoViewProps, HybridViewMethods>(
  'StimVideoView',
  () => StimVideoViewConfig,
);
