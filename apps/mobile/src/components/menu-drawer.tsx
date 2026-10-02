import { t } from '@lingui/core/macro';
import { useIsFocused } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, Platform, useWindowDimensions, type ViewStyle } from 'react-native';
import { Drawer, useDrawerProgress } from 'react-native-drawer-layout';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  type CSSTransitionProperties,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ReservedRegionsProvider, useReservedRegions } from 'react-native-reserved-regions';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useLargeText } from '@/hooks/large-text';
import { sidebarOf } from '@/lib/sidebar';
import { Menu } from '@/screens/menu';

const DISPLAY_RADIUS = Platform.select({ ios: 55, default: 28 });
const PANE_TRANSITION = '200ms cubic-bezier(0.77, 0, 0.175, 1)';

const MenuDrawerContext = createContext<{ open: () => void; permanent: boolean }>({ open: () => {}, permanent: false });

export function useMenuDrawer() {
  return useContext(MenuDrawerContext);
}

export function MenuDrawer({ children }: { children: ReactNode }) {
  const window = useWindowDimensions();
  const [layout, setLayout] = useState({ width: window.width, height: window.height });
  return (
    <ReservedRegionsProvider style={styles.root} onLayout={({ nativeEvent }) => setLayout(nativeEvent.layout)}>
      <DrawerContent layout={layout}>{children}</DrawerContent>
    </ReservedRegionsProvider>
  );
}

function DrawerContent({ children, layout }: { children: ReactNode; layout: { width: number; height: number } }) {
  const { theme } = useUnistyles();
  const large = useLargeText();
  const focused = useIsFocused();
  const [open, setOpen] = useState(false);
  const sidebar = sidebarOf(useReservedRegions(), layout.width, layout.height);
  const permanent = sidebar !== null;
  const reducedMotion = useReducedMotion();
  const value = useMemo(() => ({ open: () => setOpen(true), permanent }), [permanent]);
  const drawerStyle: ViewStyle & CSSTransitionProperties = {
    width: (permanent ? sidebar?.width : undefined) ?? (large ? '95%' : '80%'),
    backgroundColor: theme.colors.sidebar,
    transition: permanent && !reducedMotion ? `width ${PANE_TRANSITION}` : 'none',
  };

  useEffect(() => {
    if (permanent || !open || !focused) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open, permanent, focused]);

  return (
    <MenuDrawerContext.Provider value={value}>
      <Drawer
        open={permanent || open}
        layout={layout}
        onOpen={() => {
          if (!permanent) setOpen(true);
        }}
        onClose={() => {
          if (!permanent) setOpen(false);
        }}
        drawerType={permanent ? 'permanent' : 'back'}
        swipeEnabled={!permanent && focused}
        style={{ backgroundColor: theme.colors.sidebar }}
        drawerStyle={drawerStyle}
        overlayStyle={styles.overlay}
        overlayAccessibilityLabel={t`Close menu`}
        renderDrawerContent={() => (
          <SafeAreaProvider style={styles.root}>
            <Menu onClose={() => setOpen(false)} />
          </SafeAreaProvider>
        )}
      >
        <SceneCard permanent={permanent} gap={permanent ? sidebar.gap : 0}>
          {children}
        </SceneCard>
      </Drawer>
    </MenuDrawerContext.Provider>
  );
}

/**
 * The background is an inline value: Reanimated can overwrite a Unistyles update on a view that also has an animated
 * style (jpudysz/react-native-unistyles#1170).
 */
function SceneCard({ children, permanent, gap }: { children: ReactNode; permanent: boolean; gap: number }) {
  const { theme } = useUnistyles();
  const progress = useDrawerProgress();
  const reducedMotion = useReducedMotion();
  const corners = useAnimatedStyle(() => ({
    borderRadius: permanent ? 0 : interpolate(progress.value, [0, 0.02], [0, DISPLAY_RADIUS], 'clamp'),
  }));
  const fade = useAnimatedStyle(() => ({
    opacity: permanent ? 1 : interpolate(progress.value, [0, 1], [1, 0.45], 'clamp'),
  }));
  return (
    <Animated.View
      style={[
        styles.card,
        permanent && styles.permanent,
        {
          marginLeft: gap,
          transition: permanent && !reducedMotion ? `marginLeft ${PANE_TRANSITION}` : 'none',
        },
        corners,
        fade,
      ]}
    >
      <Animated.View style={[styles.clip, { backgroundColor: theme.colors.background }, corners]}>
        <SafeAreaProvider style={styles.root}>{children}</SafeAreaProvider>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  permanent: { boxShadow: 'none' },
  overlay: { backgroundColor: 'transparent' },
  card: { flex: 1, borderCurve: 'continuous', boxShadow: `-6px 0 24px ${theme.colors.scrim}` },
  clip: { flex: 1, borderCurve: 'continuous', overflow: 'hidden' },
}));
