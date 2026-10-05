import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { ListRow, ListSection } from '@/components/list';
import { describeState } from '@/components/mac-chip';
import { SheetScreen } from '@/components/sheet-screen';
import { Text } from '@/components/text';
import { useMacs, type PairedConnection } from '@/hooks/machines';
import { formatDateTime } from '@/intl/format';
import {
  appAndFlowLibraries,
  bugReportUrl,
  plainState,
  diagnosticText,
  shortId,
  versionWithBuild,
  type AboutApp,
  type AboutDevice,
  type AboutMachine,
} from '@/lib/about';
import { hapticFeedback } from '@/lib/haptics';
import { LICENSES } from '@/lib/licenses';
import { PROTOCOL_VERSION } from '@/protocol/types';

const ICON = require('@/assets/images/icon-ios.png');

/** The generated list starts with Stim's own license. */
const STIM_LICENSE = 0;

const WEBSITE = 'https://stim.appandflow.com';
const REPOSITORY = 'https://github.com/appandflow/stim';
const APP_AND_FLOW = 'https://appandflow.com';

const LIBRARIES = appAndFlowLibraries(LICENSES);

function appInfo(): AboutApp {
  return {
    version: Constants.expoConfig?.version ?? '',
    build: Constants.nativeBuildVersion ?? null,
    platform: Platform.OS,
    runtimeVersion: Updates.runtimeVersion,
    channel: Updates.channel,
    updateId: Updates.updateId,
    updatedAt: Updates.createdAt,
    embedded: Updates.isEmbeddedLaunch,
    protocol: PROTOCOL_VERSION,
  };
}

function deviceInfo(): AboutDevice {
  return {
    os: Platform.OS,
    osVersion: String(Platform.Version),
    model: (Platform.OS === 'android' ? Platform.constants.Model : Constants.platform?.ios?.model) || null,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
}

function machineInfo({ mac, state, missing }: PairedConnection): AboutMachine {
  if (state.kind !== 'open')
    return { name: mac.name, detail: { state: describeState(state, missing), plain: plainState(state, missing) } };
  return {
    name: mac.name,
    detail: { stim: state.server.stim, server: state.server.version, protocol: state.protocol },
  };
}

export function About({ onClose }: { onClose?: () => void }) {
  const router = useRouter();
  const { connections } = useMacs();
  const [copied, setCopied] = useState(false);
  const app = appInfo();

  const version = versionWithBuild(app);
  const published = app.updatedAt ? formatDateTime(app.updatedAt, { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const builtIn = app.embedded || !app.updateId;
  const copy = () =>
    void Clipboard.setStringAsync(diagnosticText(app, connections.map(machineInfo), deviceInfo())).then(() => {
      hapticFeedback('success');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  const open = (url: string) => void Linking.openURL(url);
  return (
    <SheetScreen>
      <View style={styles.header}>
        <Image source={ICON} style={styles.icon} accessibilityIgnoresInvertColors />
        <Text variant="title">
          <Trans>Stim</Trans>
        </Text>
        <Text variant="callout" tone="secondary" selectable>
          <Trans>Version {version}</Trans>
        </Text>
      </View>
      <ListSection
        title={t`This phone`}
        action={
          <Button
            variant="plain"
            size="small"
            title={copied ? t`Copied` : t`Copy`}
            accessibilityLabel={copied ? t`Copied` : t`Copy versions`}
            onPress={copy}
          />
        }
      >
        {app.runtimeVersion ? <ListRow title={t`Runtime`} value={shortId(app.runtimeVersion)} /> : null}
        {app.channel ? <ListRow title={t`Channel`} value={app.channel} /> : null}
        <ListRow
          title={t`Update`}
          value={builtIn ? t`Built-in` : shortId(app.updateId ?? '')}
          subtitle={!builtIn && published ? t`Published ${published}` : undefined}
        />
        <ListRow title={t`Protocol`} value={String(app.protocol)} />
      </ListSection>
      {connections.length > 0 ? (
        <ListSection title={t`Machines`}>
          {connections.map((connection) => {
            const { name, detail } = machineInfo(connection);
            return 'stim' in detail ? (
              <MachineRow key={connection.mac.id} name={name} stim={detail.stim} server={detail.server} />
            ) : (
              <ListRow
                key={connection.mac.id}
                title={name}
                value={detail.state}
                valueTone={connection.state.kind === 'refused' ? 'warning' : 'secondary'}
              />
            );
          })}
        </ListSection>
      ) : null}
      <ListSection>
        <ListRow
          title={t`Report a bug`}
          accessory="chevron"
          onPress={() => open(bugReportUrl(app, connections.map(machineInfo), deviceInfo()))}
        />
        <ListRow title={t`Website`} accessory="chevron" onPress={() => open(WEBSITE)} />
        <ListRow title={t`GitHub`} accessory="chevron" onPress={() => open(REPOSITORY)} />
        <ListRow
          title={t`License`}
          value={LICENSES[STIM_LICENSE].license}
          accessory="chevron"
          onPress={() => {
            onClose?.();
            router.push({ pathname: '/license', params: { index: String(STIM_LICENSE) } });
          }}
        />
        <ListRow
          title={t`Open source licenses`}
          accessory="chevron"
          onPress={() => {
            onClose?.();
            router.push('/licenses');
          }}
        />
        <ListRow title={t`Made by App&Flow`} accessory="chevron" onPress={() => open(APP_AND_FLOW)} />
      </ListSection>
      <ListSection title={t`Open source by App&Flow`}>
        {LIBRARIES.map((library) => (
          <ListRow key={library.name} title={library.name} accessory="chevron" onPress={() => open(library.url)} />
        ))}
      </ListSection>
    </SheetScreen>
  );
}

function MachineRow({ name, stim, server }: { name: string; stim: string; server: string }) {
  return <ListRow title={name} subtitle={t`stim ${stim} \u00B7 server ${server}`} />;
}

const styles = StyleSheet.create((theme) => ({
  header: { alignItems: 'center', gap: theme.space.xs },
  icon: {
    width: 64,
    height: 64,
    marginBottom: theme.space.md,
    borderRadius: theme.radius.sheet,
    borderCurve: 'continuous',
  },
}));
