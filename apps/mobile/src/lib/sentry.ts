import * as Sentry from '@sentry/react-native';
import * as Updates from 'expo-updates';

import { scrubBreadcrumb, scrubEvent } from './sentry-scrub';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: __DEV__ ? 'development' : 'production',
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableNetworkBreadcrumbs: false,
    enableNetworkEventBreadcrumbs: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  Sentry.setTags({
    'expo.updates.update_id': Updates.updateId ?? 'none',
    'expo.updates.channel': Updates.channel ?? 'none',
    'expo.updates.runtime_version': Updates.runtimeVersion ?? 'none',
  });
}
