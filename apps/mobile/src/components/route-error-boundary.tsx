import { t } from '@lingui/core/macro';
import * as Sentry from '@sentry/react-native';
import { router, type ErrorBoundaryProps } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';

function leave() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function RouteErrorFallback({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.container}>
      <EmptyState title={t`This screen could not be shown`} message={error.message}>
        <Button title={t`Try again`} onPress={() => void retry()} />
        <Button title={t`Back`} variant="plain" onPress={leave} />
      </EmptyState>
    </View>
  );
}

/** Keeps a render error in one machine screen from replacing the whole app, so the drawer and the other screens stay usable. */
export const RouteErrorBoundary = Sentry.wrapExpoRouterErrorBoundary(RouteErrorFallback);

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
}));
