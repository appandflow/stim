import type { HybridObject, HybridView, HybridViewMethods, HybridViewProps } from 'react-native-nitro-modules';

export interface Ticker extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  readonly id: number;
  readonly count: number;
  readonly hasConsumer: boolean;
  start(): void;
  stop(): void;
}

export interface TickerViewProps extends HybridViewProps {
  ticker?: Ticker;
}

export type TickerView = HybridView<TickerViewProps, HybridViewMethods, { ios: 'swift'; android: 'kotlin' }>;
