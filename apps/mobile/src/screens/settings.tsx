import { Host } from '@expo/ui';
import {
  Column,
  DropdownMenu,
  DropdownMenuItem,
  Icon,
  LazyColumn,
  ListItem,
  Switch,
  Text,
} from '@expo/ui/jetpack-compose';
import { clickable, clip, fillMaxSize, fillMaxWidth, padding, Shapes } from '@expo/ui/jetpack-compose/modifiers';
import { t } from '@lingui/core/macro';
import { router } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Children, isValidElement, useState, type ReactNode } from 'react';
import type { ImageSourcePropType } from 'react-native';

import { describeState } from '@/components/mac-chip';
import { explainReadOnly } from '@/components/read-only';
import { useHomeFilters } from '@/hooks/home-filters';
import { useMacs } from '@/hooks/machines';
import { useNotificationPrefs } from '@/hooks/notifications';
import { NOTIFY_CATEGORIES, type NotifyLevel } from '@/lib/notifications';
import type { OversightCategory } from '@/lib/oversight';
import { useRecordingSetting } from '@/hooks/recording-setting';
import { useSettings } from '@/hooks/settings';
import { pairingScope, type StimConnection } from '@/lib/connection';
import {
  appearanceOptions,
  homeViewOptions,
  labelOf,
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

const ICONS = {
  appearance: require('@/assets/icons/contrast.xml'),
  home: require('@/assets/icons/home.xml'),
  idle: require('@/assets/icons/bedtime.xml'),
  video: require('@/assets/icons/videocam.xml'),
  machine: require('@/assets/icons/laptop-mac.xml'),
  notifications: require('@/assets/icons/notifications.xml'),
  about: require('@/assets/icons/info.xml'),
} satisfies Record<string, ImageSourcePropType>;

export function Settings() {
  const { theme, rt } = useUnistyles();
  const colors = theme.colors;
  const scheme = rt.themeName === 'dark' ? 'dark' : 'light';
  const { appearance, setAppearance, videoQuality, setVideoQuality } = useSettings();
  const { filters, update, view, setView } = useHomeFilters();
  const { connections } = useMacs();
  const { prefs, enable, update: updateNotifications } = useNotificationPrefs();
  const setLevel = (category: OversightCategory, level: NotifyLevel) =>
    updateNotifications({ levels: { ...prefs.levels, [category]: level } });
  const switchColors = switchColorsFor(colors);
  const showIdle = filters.activity !== 'live';
  const anyReadOnly = connections.some(({ state }) => pairingScope(state) === 'read');

  return (
    <Host style={{ flex: 1 }} colorScheme={scheme} seedColor={colors.primary}>
      <LazyColumn
        verticalArrangement={{ spacedBy: 24 }}
        contentPadding={{ start: 16, end: 16, top: 16, bottom: 32 }}
        modifiers={[fillMaxSize()]}
      >
        <Section colors={colors} title={t`Appearance`}>
          <Choice
            colors={colors}
            title={t`Appearance`}
            icon={ICONS.appearance}
            options={appearanceOptions()}
            value={appearance}
            onChange={setAppearance}
          />
        </Section>
        <Section colors={colors} title={t`Home`}>
          <Choice
            colors={colors}
            title={t`Home view`}
            icon={ICONS.home}
            options={homeViewOptions()}
            value={view}
            onChange={setView}
          />
          <Row
            colors={colors}
            title={t`Show idle workspaces`}
            icon={ICONS.idle}
            onPress={() => update({ activity: showIdle ? 'live' : 'all' })}
            trailing={
              <Switch
                value={showIdle}
                onCheckedChange={(show) => update({ activity: show ? 'all' : 'live' })}
                colors={switchColors}
              />
            }
          />
        </Section>
        <Section colors={colors} title={t`Notifications`} footer={notificationsFooter()}>
          <Row
            colors={colors}
            title={t`Notify when something needs attention`}
            icon={ICONS.notifications}
            onPress={() => (prefs.enabled ? updateNotifications({ enabled: false }) : void enable())}
            trailing={
              <Switch
                value={prefs.enabled}
                onCheckedChange={(on) => (on ? void enable() : updateNotifications({ enabled: false }))}
                colors={switchColors}
              />
            }
          />
          {prefs.enabled
            ? NOTIFY_CATEGORIES.map((category) => (
                <Choice
                  key={category}
                  colors={colors}
                  title={notifyCategoryLabel(category)}
                  options={notifyLevelOptions()}
                  value={prefs.levels[category]}
                  onChange={(level) => setLevel(category, level)}
                />
              ))
            : null}
          {prefs.enabled && prefs.levels.stuck !== 'off' ? (
            <Choice
              colors={colors}
              title={t`Stuck after`}
              icon={ICONS.notifications}
              options={stuckMinutesOptions()}
              value={String(prefs.stuckMinutes)}
              onChange={(value) => updateNotifications({ stuckMinutes: Number(value) })}
            />
          ) : null}
          {prefs.enabled ? (
            <Choice
              colors={colors}
              title={t`Quiet hours`}
              icon={ICONS.idle}
              options={quietHoursOptions()}
              value={quietHoursValue(prefs.quietHours)}
              onChange={(value) => updateNotifications({ quietHours: parseQuietHoursValue(value) })}
            />
          ) : null}
        </Section>
        <Section colors={colors} title={t`Device view`} footer={videoQualityFooter()}>
          <Choice
            colors={colors}
            title={t`Video quality`}
            icon={ICONS.video}
            options={videoQualityOptions()}
            value={videoQuality}
            onChange={setVideoQuality}
          />
        </Section>
        {connections.length > 0 ? (
          <Section colors={colors} title={t`Machines`} footer={anyReadOnly ? readOnlyFooter() : undefined}>
            {connections.map(({ mac, state, missing, connection }) => {
              const scope = pairingScope(state);
              return (
                <Row
                  key={mac.id}
                  colors={colors}
                  title={mac.name}
                  icon={ICONS.machine}
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
                />
              );
            })}
          </Section>
        ) : null}
        {connections.some(({ state }) => pairingScope(state) === 'control') ? (
          <Section colors={colors} title={t`Replay`} footer={replayFooter()}>
            {connections
              .filter(({ state }) => pairingScope(state) === 'control')
              .map(({ mac, connection }) => (
                <RecordingRow key={mac.id} colors={colors} name={mac.name} connection={connection} />
              ))}
          </Section>
        ) : null}
        <Section colors={colors} title={t`More`}>
          <Row colors={colors} title={t`About Stim`} icon={ICONS.about} onPress={() => router.push('/about')} />
          <Row
            colors={colors}
            title={t`Open source licenses`}
            icon={ICONS.about}
            onPress={() => router.push('/licenses')}
          />
        </Section>
      </LazyColumn>
    </Host>
  );
}

const FULL = 20;
const JOIN = 4;

const switchColorsFor = (colors: Theme['colors']) => ({
  checkedTrackColor: colors.primary,
  checkedThumbColor: colors.onPrimary,
});

function RecordingRow({
  colors,
  name,
  connection,
}: {
  colors: Theme['colors'];
  name: string;
  connection: StimConnection | null;
}) {
  const setting = useRecordingSetting(connection);
  if (setting.enabled === null) return null;
  const locked = setting.fromEnvironment || setting.saving;
  return (
    <Row
      colors={colors}
      title={t`Record on ${name}`}
      icon={ICONS.video}
      value={setting.fromEnvironment ? t`Set by STIM_RECORDING on the Mac` : (setting.error ?? undefined)}
      valueColor={setting.error ? colors.error : undefined}
      onPress={() => !locked && setting.set(!setting.enabled)}
      trailing={
        <Switch
          value={setting.enabled}
          enabled={!locked}
          onCheckedChange={setting.set}
          colors={switchColorsFor(colors)}
        />
      }
    />
  );
}

function Section({
  colors,
  title,
  footer,
  children,
}: {
  colors: Theme['colors'];
  title: string;
  footer?: string;
  children: ReactNode;
}) {
  const rows = Children.toArray(children);
  const last = rows.length - 1;
  return (
    <Column verticalArrangement={{ spacedBy: 2 }} modifiers={[fillMaxWidth()]}>
      <Text color={colors.primary} style={{ typography: 'labelLarge' }} modifiers={[padding(16, 0, 16, 6)]}>
        {title}
      </Text>
      {rows.map((row, index) => (
        <Column
          key={isValidElement(row) ? row.key : index}
          modifiers={[
            fillMaxWidth(),
            clip(
              Shapes.RoundedCorner({
                topStart: index === 0 ? FULL : JOIN,
                topEnd: index === 0 ? FULL : JOIN,
                bottomStart: index === last ? FULL : JOIN,
                bottomEnd: index === last ? FULL : JOIN,
              }),
            ),
          ]}
        >
          {row}
        </Column>
      ))}
      {footer ? (
        <Text color={colors.secondary} style={{ typography: 'bodySmall' }} modifiers={[padding(16, 6, 16, 0)]}>
          {footer}
        </Text>
      ) : null}
    </Column>
  );
}

function Row({
  colors,
  title,
  icon,
  value,
  valueColor,
  trailing,
  onPress,
}: {
  colors: Theme['colors'];
  title: string;
  icon?: ImageSourcePropType;
  value?: string;
  valueColor?: string;
  trailing?: ReactNode;
  onPress: () => void;
}) {
  return (
    <ListItem
      colors={{
        containerColor: colors.groupedRow,
        contentColor: colors.text,
        supportingContentColor: valueColor ?? colors.secondary,
      }}
      modifiers={[fillMaxWidth(), clickable(onPress)]}
    >
      {icon ? (
        <ListItem.LeadingContent>
          <Icon source={icon} size={24} tint={colors.primary} />
        </ListItem.LeadingContent>
      ) : null}
      <ListItem.HeadlineContent>
        <Text>{title}</Text>
      </ListItem.HeadlineContent>
      {value ? (
        <ListItem.SupportingContent>
          <Text>{value}</Text>
        </ListItem.SupportingContent>
      ) : null}
      {trailing ? <ListItem.TrailingContent>{trailing}</ListItem.TrailingContent> : null}
    </ListItem>
  );
}

function Choice<T extends string>({
  colors,
  title,
  icon,
  options,
  value,
  onChange,
}: {
  colors: Theme['colors'];
  title: string;
  icon?: ImageSourcePropType;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)} modifiers={[fillMaxWidth()]}>
      <DropdownMenu.Trigger>
        <Row colors={colors} title={title} icon={icon} value={labelOf(options, value)} onPress={() => setOpen(true)} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => {
              setOpen(false);
              onChange(option.value);
            }}
          >
            <DropdownMenuItem.Text>
              <Text>{option.label}</Text>
            </DropdownMenuItem.Text>
          </DropdownMenuItem>
        ))}
      </DropdownMenu.Items>
    </DropdownMenu>
  );
}
