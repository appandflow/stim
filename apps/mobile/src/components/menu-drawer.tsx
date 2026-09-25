import { usePathname } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler } from 'react-native';
import { Drawer } from 'react-native-drawer-layout';

import { Menu } from '@/screens/menu';
import { useColors } from '@/theme';

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
        swipeEnabled={open || pathname === '/'}
        drawerStyle={{ width: '85%', backgroundColor: colors.background }}
        overlayAccessibilityLabel="Close menu"
        renderDrawerContent={() => <Menu onClose={() => setOpen(false)} />}
      >
        {children}
      </Drawer>
    </MenuDrawerContext.Provider>
  );
}
