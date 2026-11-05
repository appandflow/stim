import { router } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ListRow } from '@/components/list';
import { FlatList } from '@/components/lists';
import { LICENSES } from '@/lib/licenses';

function Separator() {
  return <View style={styles.separator} />;
}

export function Licenses() {
  return (
    <FlatList
      style={styles.list}
      contentInsetAdjustmentBehavior="automatic"
      data={LICENSES}
      keyExtractor={(item) => `${item.name}@${item.version}`}
      ItemSeparatorComponent={Separator}
      renderItem={({ item, index }) => (
        <ListRow
          title={item.name}
          subtitle={`${item.version} - ${item.license}`}
          accessory="chevron"
          onPress={() => router.push({ pathname: '/license', params: { index: String(index) } })}
        />
      )}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { backgroundColor: theme.colors.background },
  separator: { height: 1, marginStart: theme.space.lg, backgroundColor: theme.colors.border },
}));
