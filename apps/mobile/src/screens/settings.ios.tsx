import { Host } from '@expo/ui';
import { Button, Form, HStack, Image, Label, Picker, Section, Spacer, Text, Toggle } from '@expo/ui/swift-ui';
import {
  background,
  buttonStyle,
  contentShape,
  disabled,
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
import { t } from '@lingui/core/macro';
import { router } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import type { SFSymbol } from 'sf-symbols-typescript';

import { describeState } from '@/components/mac-chip';
import { explainReadOnly } from '@/components/read-only';
import { useHomeFilters } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/machines';
import { useNotificationPrefs } from '@/hooks/notifications';
import { NOTIFY_CATEGORIES, type NotifyLevel } from '@/lib/notifications';
import type { OversightCategory } from '@stim-cli/core/oversight';
import { useRecordingSetting } from '@/hooks/recording-setting';
import { useSettings } from '@/hooks/settings';
import { pairingScope, type StimConnection } from '@/lib/connection';
import { getRunningVersion } from '@/lib/running-version';
import {
  appearanceOptions,
  homeViewOptions,
  notificationsFooter,
  notifyCategoryLabel,
  notifyLevelOptions,
  parseQuietHoursValue,
  quietHoursOptions,
  quietHoursValue,
  readOnlyFooter,
  replayFooter,
  stuckMinutesOptions,
  videoQualityFooter,
  videoQualityOptions,
  type Option,
} from '@/lib/settings-options';
import type { Theme } from '@/design/theme';
import { radius } from '@/design/tokens';

export function Settings() {
  const colors = useUnistyles().theme.colors;
  const { appearance, setAppearance, videoQuality, setVideoQuality } = useSettings();
  const { filters, update, view, setView } = useHomeFilters();
  const { connections } = useMacs();
  const notifications = useNotificationPrefs();
  const rowModifiers = [listRowBackground(colors.raised)];
  const anyReadOnly = connections.some(({ state }) => pairingScope(state) === 'read');
  const running = getRunningVersion();

  return (
    <Host style={{ flex: 1 }}>
      <Form modifiers={[scrollContentBackground('hidden'), background(colors.background), tint(colors.primary)]}>
        <Section title={t`Appearance`}>
          <Choice
            colors={colors}
            title={t`Appearance`}
            symbol="circle.lefthalf.filled"
            options={appearanceOptions()}
            value={appearance}
            onChange={setAppearance}
            modifiers={rowModifiers}
          />
        </Section>
        <Section title={t`Home`}>
          <Choice
            colors={colors}
            title={t`Home view`}
            symbol="house"
            options={homeViewOptions()}
            value={view}
            onChange={setView}
            modifiers={rowModifiers}
          />
          <Toggle
            isOn={filters.activity !== 'live'}
            onIsOnChange={(show) => update({ activity: show ? 'all' : 'live' })}
            modifiers={rowModifiers}
          >
            <RowLabel colors={colors} title={t`Show idle workspaces`} symbol="moon.zzz" />
          </Toggle>
        </Section>
        <NotificationsSection colors={colors} value={notifications} modifiers={rowModifiers} />
        <Section title={t`Device view`} footer={<Text>{videoQualityFooter()}</Text>}>
          <Choice
            colors={colors}
            title={t`Video quality`}
            symbol="video"
            options={videoQualityOptions()}
            value={videoQuality}
            onChange={setVideoQuality}
            modifiers={rowModifiers}
          />
        </Section>
        {connections.length > 0 ? (
          <Section title={t`Machines`} footer={anyReadOnly ? <Text>{readOnlyFooter()}</Text> : undefined}>
            {connections.map(({ mac, state, missing, connection }) => {
              const scope = pairingScope(state);
              return (
                <LinkRow
                  key={mac.id}
                  colors={colors}
                  title={mac.name}
                  symbol="laptopcomputer"
                  value={
                    scope === 'control'
                      ? t`Can control`
                      : scope === 'read'
                        ? t`Read-only`
                        : describeState(state, missing)
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
        {connections.some(({ state }) => pairingScope(state) === 'control') ? (
          <Section title={t`Replay`} footer={<Text>{replayFooter()}</Text>}>
            {connections
              .filter(({ state }) => pairingScope(state) === 'control')
              .map(({ mac, connection }) => (
                <RecordingToggle
                  key={mac.id}
                  colors={colors}
                  name={mac.name}
                  connection={connection}
                  modifiers={rowModifiers}
                />
              ))}
          </Section>
        ) : null}
        <Section title={t`More`} footer={<Text>{`${running.version}\n${running.update}`}</Text>}>
          <LinkRow
            colors={colors}
            title={t`About Stim`}
            symbol="info.circle"
            onPress={() => router.push('/about')}
            modifiers={rowModifiers}
          />
          <LinkRow
            colors={colors}
            title={t`Open source licenses`}
            symbol="doc.text"
            onPress={() => router.push('/licenses')}
            modifiers={rowModifiers}
          />
        </Section>
      </Form>
    </Host>
  );
}

type RowModifiers = ReturnType<typeof listRowBackground>[];

const CATEGORY_SYMBOLS: Record<OversightCategory, SFSymbol> = {
  started: 'play.circle',
  stuck: 'hourglass',
  looping: 'arrow.triangle.2.circlepath',
  finished: 'checkmark.circle',
  machine: 'laptopcomputer.trianglebadge.exclamationmark',
  control: 'hand.raised',
  attention: 'exclamationmark.bubble',
};

function NotificationsSection({
  colors,
  value,
  modifiers,
}: {
  colors: Theme['colors'];
  value: ReturnType<typeof useNotificationPrefs>;
  modifiers: RowModifiers;
}) {
  const { prefs, enable, update } = value;
  const setLevel = (category: OversightCategory, level: NotifyLevel) =>
    update({ levels: { ...prefs.levels, [category]: level } });
  return (
    <Section title={t`Notifications`} footer={<Text>{notificationsFooter()}</Text>}>
      <Toggle
        isOn={prefs.enabled}
        onIsOnChange={(on) => (on ? void enable() : update({ enabled: false }))}
        modifiers={modifiers}
      >
        <RowLabel colors={colors} title={t`Notify when something needs attention`} symbol="bell.badge" />
      </Toggle>
      {prefs.enabled
        ? NOTIFY_CATEGORIES.map((category) => (
            <Choice
              key={category}
              colors={colors}
              title={notifyCategoryLabel(category)}
              symbol={CATEGORY_SYMBOLS[category]}
              options={notifyLevelOptions()}
              value={prefs.levels[category]}
              onChange={(level) => setLevel(category, level)}
              modifiers={modifiers}
            />
          ))
        : null}
      {prefs.enabled && prefs.levels.stuck !== 'off' ? (
        <Choice
          colors={colors}
          title={t`Stuck after`}
          symbol="timer"
          options={stuckMinutesOptions()}
          value={String(prefs.stuckMinutes)}
          onChange={(value) => update({ stuckMinutes: Number(value) })}
          modifiers={modifiers}
        />
      ) : null}
      {prefs.enabled ? (
        <Choice
          colors={colors}
          title={t`Quiet hours`}
          symbol="moon"
          options={quietHoursOptions()}
          value={quietHoursValue(prefs.quietHours)}
          onChange={(value) => update({ quietHours: parseQuietHoursValue(value) })}
          modifiers={modifiers}
        />
      ) : null}
    </Section>
  );
}

function RecordingToggle({
  colors,
  name,
  connection,
  modifiers,
}: {
  colors: Theme['colors'];
  name: string;
  connection: StimConnection | null;
  modifiers: ReturnType<typeof listRowBackground>[];
}) {
  const setting = useRecordingSetting(connection);
  if (setting.enabled === null) return null;
  const { error } = setting;
  const title = setting.fromEnvironment
    ? t`Record on ${name} (set by STIM_RECORDING)`
    : error
      ? t`Record on ${name}: ${error}`
      : t`Record on ${name}`;
  return (
    <Toggle
      isOn={setting.enabled}
      onIsOnChange={setting.set}
      modifiers={[...modifiers, disabled(setting.fromEnvironment || setting.saving)]}
    >
      <RowLabel colors={colors} title={title} symbol="record.circle" />
    </Toggle>
  );
}

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
