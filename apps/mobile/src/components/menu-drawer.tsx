import { usePathname } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, Platform, StyleSheet } from 'react-native';
import { Drawer, useDrawerProgress } from 'react-native-drawer-layout';
import Animated, { interpolate, useAnimatedStyle } from 'react-native-reanimated';

import { Menu } from '@/screens/menu';
import { useColors } from '@/theme';

const DISPLAY_RADIUS = Platform.select({ ios: 55, default: 28 });

const MenuDrawerContext = createContext<{ open: () => void }>({ open: () => {} });

export function useMenuDrawer() {
  return useContext(MenuDrawerContext);
}

export function MenuDrawer({ children }: { children: ReactNode }) {
  const colors = useColors();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open: () => setOpen(true) }), []);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open]);

  return (
    <MenuDrawerContext.Provider value={value}>
      <Drawer
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        drawerType="back"
        swipeEnabled={open || pathname === '/'}
        style={{ backgroundColor: colors.sidebar }}
        drawerStyle={{ width: '80%', backgroundColor: colors.sidebar }}
        overlayStyle={styles.overlay}
        overlayAccessibilityLabel="Close menu"
        renderDrawerContent={() => <Menu onClose={() => setOpen(false)} />}
      >
        <SceneCard>{children}</SceneCard>
      </Drawer>
    </MenuDrawerContext.Provider>
  );
}

function SceneCard({ children }: { children: ReactNode }) {
  const colors = useColors();
  const progress = useDrawerProgress();
  const corners = useAnimatedStyle(() => ({
    borderRadius: interpolate(progress.value, [0, 0.02], [0, DISPLAY_RADIUS], 'clamp'),
  }));
  return (
    <Animated.View style={[styles.card, corners]}>
      <Animated.View style={[styles.clip, { backgroundColor: colors.background }, corners]}>{children}</Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { backgroundColor: 'transparent' },
  card: { flex: 1, borderCurve: 'continuous', boxShadow: '-6px 0 24px rgba(0, 0, 0, 0.14)' },
  clip: { flex: 1, borderCurve: 'continuous', overflow: 'hidden' },
});
