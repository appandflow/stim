import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance as SystemAppearance } from 'react-native';

export type Appearance = 'system' | 'light' | 'dark';

const applyAppearance = (value: Appearance) =>
  SystemAppearance.setColorScheme(value === 'system' ? 'unspecified' : value);

const APPEARANCE_KEY = 'stim.appearance';
const VIDEO_QUALITY_KEY = 'stim.videoQuality';
const DEVICE_FRAME_KEY = 'stim.deviceFrame';

export type VideoQuality = 'auto' | 'high' | 'dataSaver';

interface SettingsContextValue {
  appearance: Appearance;
  setAppearance: (value: Appearance) => void;
  videoQuality: VideoQuality;
  setVideoQuality: (value: VideoQuality) => void;
  deviceFrame: boolean;
  setDeviceFrame: (value: boolean) => void;
}

const Context = createContext<SettingsContextValue>({
  appearance: 'system',
  setAppearance: () => {},
  videoQuality: 'auto',
  setVideoQuality: () => {},
  deviceFrame: false,
  setDeviceFrame: () => {},
});

const parseAppearance = (raw: string | null): Appearance => (raw === 'light' || raw === 'dark' ? raw : 'system');
const parseVideoQuality = (raw: string | null): VideoQuality => (raw === 'high' || raw === 'dataSaver' ? raw : 'auto');

/** Appearance, device-view quality and device frame, saved on this phone so they survive restarts. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>('system');
  const [videoQuality, setVideoQualityState] = useState<VideoQuality>('auto');
  const [deviceFrame, setDeviceFrameState] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(APPEARANCE_KEY).then(
      (raw) => {
        const next = parseAppearance(raw);
        setAppearanceState(next);
        applyAppearance(next);
      },
      () => {},
    );
    SecureStore.getItemAsync(VIDEO_QUALITY_KEY).then(
      (raw) => setVideoQualityState(parseVideoQuality(raw)),
      () => {},
    );
    SecureStore.getItemAsync(DEVICE_FRAME_KEY).then(
      (raw) => setDeviceFrameState(raw === 'on'),
      () => {},
    );
  }, []);

  const setAppearance = useCallback((next: Appearance) => {
    setAppearanceState(next);
    applyAppearance(next);
    SecureStore.setItemAsync(APPEARANCE_KEY, next).catch(() => {});
  }, []);
  const setVideoQuality = useCallback((next: VideoQuality) => {
    setVideoQualityState(next);
    SecureStore.setItemAsync(VIDEO_QUALITY_KEY, next).catch(() => {});
  }, []);

  const setDeviceFrame = useCallback((next: boolean) => {
    setDeviceFrameState(next);
    SecureStore.setItemAsync(DEVICE_FRAME_KEY, next ? 'on' : 'off').catch(() => {});
  }, []);

  const value = useMemo(
    () => ({ appearance, setAppearance, videoQuality, setVideoQuality, deviceFrame, setDeviceFrame }),
    [appearance, setAppearance, videoQuality, setVideoQuality, deviceFrame, setDeviceFrame],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(Context);
}
