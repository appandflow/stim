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
import { router } from 'expo-router';
import { Children, useState, type ReactNode } from 'react';
import type { ImageSourcePropType } from 'react-native';

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
  labelOf,
  READ_ONLY_FOOTER,
  VIDEO_QUALITY_FOOTER,
  VIDEO_QUALITY_OPTIONS,
  type Option,
} from '@/lib/settings-options';
import { useColors, useEffectiveScheme, type Colors } from '@/theme';

const ICONS = {
  appearance: require('@/assets/icons/contrast.xml'),
  home: require('@/assets/icons/home.xml'),
  idle: require('@/assets/icons/bedtime.xml'),
  video: require('@/assets/icons/videocam.xml'),
  machine: require('@/assets/icons/laptop-mac.xml'),
  about: require('@/assets/icons/info.xml'),
} satisfies Record<string, ImageSourcePropType>;

/** The Android screen, in Jetpack Compose; `settings.ios.tsx` is the SwiftUI one. */
export function Settings() {
  const colors = useColors();
  const scheme = useEffectiveScheme();
  const { appearance, setAppearance, videoQuality, setVideoQuality } = useSettings();
  const { filters, update, view, setView } = useHomeFilters();
  const { connections } = useMacs();
  const showIdle = filters.activity !== 'live';
  const anyReadOnly = connections.some(({ state }) => pairingScope(state) === 'read');

  return (
    <Host style={{ flex: 1 }} colorScheme={scheme} seedColor={colors.primary}>
      <LazyColumn
        verticalArrangement={{ spacedBy: 24 }}
        contentPadding={{ start: 16, end: 16, top: 16, bottom: 32 }}
        modifiers={[fillMaxSize()]}
      >
        <Section colors={colors} title="Appearance">
          <Choice
            colors={colors}
            title="Appearance"
            icon={ICONS.appearance}
            options={APPEARANCE_OPTIONS}
            value={appearance}
            onChange={setAppearance}
          />
        </Section>
        <Section colors={colors} title="Home" footer={HOME_FOOTER}>
          <Choice
            colors={colors}
            title="Home view"
            icon={ICONS.home}
            options={HOME_VIEW_OPTIONS}
            value={view}
            onChange={setView}
          />
          <Row
            colors={colors}
            title="Show idle workspaces"
            icon={ICONS.idle}
            onPress={() => update({ activity: showIdle ? 'live' : 'all' })}
            trailing={
              <Switch
                value={showIdle}
                onCheckedChange={(show) => update({ activity: show ? 'all' : 'live' })}
                colors={{ checkedTrackColor: colors.primary, checkedThumbColor: colors.onPrimary }}
              />
            }
          />
        </Section>
        <Section colors={colors} title="Device view" footer={VIDEO_QUALITY_FOOTER}>
          <Choice
            colors={colors}
            title="Video quality"
            icon={ICONS.video}
            options={VIDEO_QUALITY_OPTIONS}
            value={videoQuality}
            onChange={setVideoQuality}
          />
        </Section>
        {connections.length > 0 ? (
          <Section colors={colors} title="Machines" footer={anyReadOnly ? READ_ONLY_FOOTER : undefined}>
            {connections.map(({ mac, state, missing, connection }) => {
              const scope = pairingScope(state);
              return (
                <Row
                  key={mac.id}
                  colors={colors}
                  title={mac.name}
                  icon={ICONS.machine}
                  value={
                    scope === 'control' ? 'Can control' : scope === 'read' ? 'Read-only' : describeState(state, missing)
                  }
                  valueColor={scope === 'read' ? colors.warn : undefined}
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
        <Section colors={colors} title="More">
          <Row colors={colors} title="About Stim" icon={ICONS.about} onPress={() => router.push('/about')} />
        </Section>
      </LazyColumn>
    </Host>
  );
}

const FULL = 20;
const JOIN = 4;

function Section({
  colors,
  title,
  footer,
  children,
}: {
  colors: Colors;
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
          key={index}
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
  colors: Colors;
  title: string;
  icon: ImageSourcePropType;
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
      <ListItem.LeadingContent>
        <Icon source={icon} size={24} tint={colors.primary} />
      </ListItem.LeadingContent>
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
  colors: Colors;
  title: string;
  icon: ImageSourcePropType;
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
