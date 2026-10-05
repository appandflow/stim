import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** Whether the app is active; independent of navigation focus. */
export function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => listener.remove();
  }, []);

  return foreground;
}
