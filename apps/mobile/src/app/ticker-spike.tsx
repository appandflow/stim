/* oxlint-disable lingui/no-unlocalized-strings -- throwaway spike screen for #3732 */
import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { createTicker, TickerView, type Ticker } from 'react-native-stim-ticker';

function blockJs(ms: number) {
  console.log(`[TickerSpike] JS blocked for ${ms} ms`);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait so the JS thread cannot run anything else.
  }
  console.log('[TickerSpike] JS unblocked');
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ backgroundColor: '#333', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 }}
    >
      <Text style={{ color: 'white', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export default function TickerSpikeRoute() {
  const all = useRef<Ticker[]>([]);
  const [ticker, setTicker] = useState<Ticker | undefined>(undefined);
  const [mounted, setMounted] = useState(true);
  const [renders, setRenders] = useState(0);
  const [status, setStatus] = useState('');

  const newTicker = () => {
    const next = createTicker();
    next.start();
    all.current.push(next);
    setTicker(next);
  };

  const readStatus = () => {
    setStatus(all.current.map((t) => `#${t.id}: count=${t.count} consumer=${t.hasConsumer}`).join('\n'));
  };

  const dropAll = () => {
    all.current = [];
    setTicker(undefined);
    setTimeout(() => {
      const gc: unknown = Reflect.get(globalThis, 'gc');
      if (typeof gc === 'function') gc();
      setStatus(`dropped all JS refs, gc ${typeof gc === 'function' ? 'called' : 'unavailable'}`);
    }, 500);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 80, gap: 12 }}>
      <Text style={{ fontSize: 13 }}>
        prop: {ticker ? `#${ticker.id}` : 'undefined'} / mounted: {String(mounted)} / renders: {renders}
      </Text>
      {mounted ? (
        <TickerView ticker={ticker} style={{ height: 120, borderRadius: 8 }} />
      ) : (
        <View style={{ height: 120 }} />
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button label="New ticker" onPress={newTicker} />
        <Button label="Detach" onPress={() => setTicker(undefined)} />
        <Button label={mounted ? 'Unmount' : 'Mount'} onPress={() => setMounted((m) => !m)} />
        <Button label="Re-render" onPress={() => setRenders((r) => r + 1)} />
        <Button label="Block JS 8s" onPress={() => blockJs(8000)} />
        <Button label="Status" onPress={readStatus} />
        <Button label="Drop all" onPress={dropAll} />
        <Button label="Orphan ticker" onPress={() => createTicker().start()} />
      </View>
      <Text style={{ fontFamily: 'Menlo', fontSize: 13 }}>{status}</Text>
    </ScrollView>
  );
}
