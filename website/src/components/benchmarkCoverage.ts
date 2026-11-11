export type CoverageStatus = 'measured' | 'planned' | 'not-applicable';

export type CoveragePlatform = {
  id: string;
  label: string;
  scenarios: string;
  arms: Record<'stim' | 'control' | 'expo-agent-cli', CoverageStatus>;
};

const planned = { stim: 'planned', control: 'planned', 'expo-agent-cli': 'not-applicable' } as const;
const expoPlanned = { stim: 'planned', control: 'planned', 'expo-agent-cli': 'planned' } as const;

export const coveragePlatforms: CoveragePlatform[] = [
  { id: 'expo-ios', label: 'Expo iOS simulator', scenarios: 'App launch, error fix', arms: expoPlanned },
  { id: 'expo-android', label: 'Expo Android emulator', scenarios: 'App launch, error fix', arms: expoPlanned },
  { id: 'bare-ios', label: 'Bare React Native iOS simulator', scenarios: 'App launch, error fix', arms: planned },
  {
    id: 'bare-android',
    label: 'Bare React Native Android emulator',
    scenarios: 'App launch, error fix',
    arms: planned,
  },
  { id: 'web', label: 'Web', scenarios: 'App launch, error fix', arms: planned },
  { id: 'macos', label: 'macOS', scenarios: 'App launch, error fix', arms: planned },
  { id: 'native-ios', label: 'Standalone native iOS', scenarios: 'App launch, error fix', arms: planned },
  { id: 'native-android', label: 'Standalone native Android', scenarios: 'App launch, error fix', arms: planned },
  { id: 'exact-ios', label: 'Exact iOS', scenarios: 'App launch, error fix', arms: planned },
];

export const coverageStatusLabels: Record<CoverageStatus, string> = {
  measured: 'Measured',
  planned: 'Planned',
  'not-applicable': 'Not supported by the tool',
};
