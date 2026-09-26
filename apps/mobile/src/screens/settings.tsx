import { FieldGroup, Host, Switch } from '@expo/ui';
import { SegmentedControl } from '@expo/ui/community/segmented-control';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { Icon } from '@/components/icon';
import { useHomeFilters, type HomeView } from '@/hooks/home-filters';
import { useSettings, type VideoQuality } from '@/hooks/settings';
import { useColors, type Appearance } from '@/theme';

const APPEARANCE_OPTIONS: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const HOME_VIEW_OPTIONS: { value: HomeView; label: string }[] = [
  { value: 'workspaces', label: 'Workspaces' },
  { value: 'devices', label: 'Devices' },
  { value: 'machines', label: 'Machines' },
];

const VIDEO_QUALITY_OPTIONS: { value: VideoQuality; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'high', label: 'High' },
  { value: 'dataSaver', label: 'Data saver' },
];

export function Settings() {
  const colors = useColors();
  const { appearance, setAppearance, videoQuality, setVideoQuality } = useSettings();
  const { filters, update, view, setView } = useHomeFilters();

  return (
    <Host style={styles.host} seedColor={colors.primary}>
      <FieldGroup style={{ backgroundColor: colors.background }}>
        <FieldGroup.Section title="Appearance">
          <ChoiceRow options={APPEARANCE_OPTIONS} value={appearance} onChange={setAppearance} />
        </FieldGroup.Section>
        <FieldGroup.Section title="Home">
          <ChoiceRow options={HOME_VIEW_OPTIONS} value={view} onChange={setView} />
          <Switch
            label="Show idle workspaces"
            value={filters.activity !== 'live'}
            onValueChange={(show) => update({ activity: show ? 'all' : 'live' })}
          />
        </FieldGroup.Section>
        <FieldGroup.Section title="Device view">
          <ChoiceRow options={VIDEO_QUALITY_OPTIONS} value={videoQuality} onChange={setVideoQuality} />
        </FieldGroup.Section>
        <FieldGroup.Section title="More">
          <LinkRow label="About Stim" onPress={() => router.push('/about')} />
        </FieldGroup.Section>
      </FieldGroup>
    </Host>
  );
}

function ChoiceRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <SegmentedControl
      values={options.map((option) => option.label)}
      selectedIndex={selectedIndex}
      onValueChange={(selectedLabel) => {
        const option = options.find((candidate) => candidate.label === selectedLabel);
        if (option) onChange(option.value);
      }}
      style={styles.segmented}
    />
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.row}>
      <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      <Icon name="chevron.right" size={15} color={colors.tertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { fontSize: 16 },
  segmented: { height: 32 },
});
