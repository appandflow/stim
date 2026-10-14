import { getHostComponent, NitroModules } from 'react-native-nitro-modules';

import TickerViewConfig from '../nitrogen/generated/shared/json/TickerViewConfig.json';
import type { Ticker, TickerViewProps } from './specs/Ticker.nitro';
import type { HybridViewMethods } from 'react-native-nitro-modules';

export type { Ticker } from './specs/Ticker.nitro';

export function createTicker(): Ticker {
  return NitroModules.createHybridObject<Ticker>('Ticker');
}

export const TickerView = getHostComponent<TickerViewProps, HybridViewMethods>('TickerView', () => TickerViewConfig);
