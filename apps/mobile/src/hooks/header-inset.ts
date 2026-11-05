import { useHeaderHeight } from 'expo-router/react-navigation';
import { Platform } from 'react-native';

export function useHeaderInset(): number {
  const height = useHeaderHeight();
  return Platform.OS === 'ios' ? height : 0;
}
