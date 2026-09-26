import { Host } from '@expo/ui';
import { Button, Form, HStack, Image, Label, Picker, Section, Spacer, Text, Toggle } from '@expo/ui/swift-ui';
import {
  background,
  buttonStyle,
  contentShape,
  font,
  foregroundStyle,
  frame,
  listRowBackground,
  pickerStyle,
  scrollContentBackground,
  shapes,
  tag,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { router } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import type { SFSymbol } from 'sf-symbols-typescript';

import { describeState } from '@/components/mac-chip';
import { explainReadOnly } from '@/components/read-only';
import { useHomeFilters } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/mac-connection';
import { useSettings } from '@/hooks/settings';
import { pairingScope } from '@/lib/connection';
import {
  APPEARANCE_OPTIONS,
  HOME_FOOTER,
  HOME_VIEW_OPTIONS,
  READ_ONLY_FOOTER,
  VIDEO_QUALITY_FOOTER,
  VIDEO_QUALITY_OPTIONS,
  type Option,
} from '@/lib/settings-options';
import type { Theme } from '@/design/theme';
import { radius } from '@/design/tokens';

export function Settings() {
  const colors = useUnistyles().theme.colors;
  const { appearance, setAppearance, videoQuality, setVideoQuality } = useSettings();
  const { filters, update, view, setView } = useHomeFilters();
  const { connections } = useMacs();
  const rowModifiers = [listRowBackground(colors.groupedRow)];
  const anyReadOnly = connections.some(({ state }) => pairingScope(state) === 'read');

  return (
    <Host style={{ flex: 1 }}>
      <Form modifiers={[scrollContentBackground('hidden'), background(colors.grouped), tint(colors.primary)]}>
        <Section title="Appearance">
          <Choice
            colors={colors}
            title="Appearance"
            symbol="circle.lefthalf.filled"
            options={APPEARANCE_OPTIONS}
            value={appearance}
            onChange={setAppearance}
            modifiers={rowModifiers}
          />
        </Section>
        <Section title="Home" footer={<Text>{HOME_FOOTER}</Text>}>
          <Choice
            colors={colors}
            title="Home view"
            symbol="house"
            options={HOME_VIEW_OPTIONS}
            value={view}
            onChange={setView}
            modifiers={rowModifiers}
          />
          <Toggle
            isOn={filters.activity !== 'live'}
            onIsOnChange={(show) => update({ activity: show ? 'all' : 'live' })}
            modifiers={rowModifiers}
          >
            <RowLabel colors={colors} title="Show idle workspaces" symbol="moon.zzz" />
          </Toggle>
        </Section>
        <Section title="Device view" footer={<Text>{VIDEO_QUALITY_FOOTER}</Text>}>
          <Choice
            colors={colors}
            title="Video quality"
            symbol="video"
            options={VIDEO_QUALITY_OPTIONS}
            value={videoQuality}
            onChange={setVideoQuality}
            modifiers={rowModifiers}
          />
        </Section>
        {connections.length > 0 ? (
          <Section title="Machines" footer={anyReadOnly ? <Text>{READ_ONLY_FOOTER}</Text> : undefined}>
            {connections.map(({ mac, state, missing, connection }) => {
              const scope = pairingScope(state);
              return (
                <LinkRow
                  key={mac.id}
                  colors={colors}
                  title={mac.name}
                  symbol="laptopcomputer"
                  value={
                    scope === 'control' ? 'Can control' : scope === 'read' ? 'Read-only' : describeState(state, missing)
                  }
                  valueColor={scope === 'read' ? colors.warning : undefined}
                  onPress={() =>
                    scope === 'read'
                      ? explainReadOnly(mac.name, state, connection)
                      : router.push({ pathname: '/mac/[id]', params: { id: mac.id } })
                  }
                  modifiers={rowModifiers}
                />
              );
            })}
          </Section>
        ) : null}
        <Section title="More">
          <LinkRow
            colors={colors}
            title="About Stim"
            symbol="info.circle"
            onPress={() => router.push('/about')}
            modifiers={rowModifiers}
          />
        </Section>
      </Form>
    </Host>
  );
}

type RowModifiers = ReturnType<typeof listRowBackground>[];

function RowLabel({ colors, title, symbol }: { colors: Theme['colors']; title: string; symbol: SFSymbol }) {
  return (
    <Label
      title={title}
      icon={
        <Image
          systemName={symbol}
          size={15}
          color={colors.onPrimary}
          modifiers={[
            frame({ width: 29, height: 29 }),
            background(colors.primary, shapes.roundedRectangle({ cornerRadius: radius.chip })),
          ]}
        />
      }
    />
  );
}

function Choice<T extends string>({
  colors,
  title,
  symbol,
  options,
  value,
  onChange,
  modifiers,
}: {
  colors: Theme['colors'];
  title: string;
  symbol: SFSymbol;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  modifiers: RowModifiers;
}) {
  return (
    <Picker
      label={<RowLabel colors={colors} title={title} symbol={symbol} />}
      selection={value}
      onSelectionChange={(selection) => onChange(selection as T)}
      modifiers={[pickerStyle('menu'), tint(colors.secondary), ...modifiers]}
    >
      {options.map((option) => (
        <Text key={option.value} modifiers={[tag(option.value)]}>
          {option.label}
        </Text>
      ))}
    </Picker>
  );
}

function LinkRow({
  colors,
  title,
  symbol,
  value,
  valueColor,
  onPress,
  modifiers,
}: {
  colors: Theme['colors'];
  title: string;
  symbol: SFSymbol;
  value?: string;
  valueColor?: string;
  onPress: () => void;
  modifiers: RowModifiers;
}) {
  return (
    <Button onPress={onPress} modifiers={[buttonStyle('plain'), ...modifiers]}>
      <HStack spacing={8} modifiers={[contentShape(shapes.rectangle())]}>
        <RowLabel colors={colors} title={title} symbol={symbol} />
        <Spacer />
        {value ? <Text modifiers={[foregroundStyle(valueColor ?? colors.secondary)]}>{value}</Text> : null}
        <Image
          systemName="chevron.right"
          size={13}
          color={colors.tertiary}
          modifiers={[font({ weight: 'semibold' })]}
        />
      </HStack>
    </Button>
  );
}
