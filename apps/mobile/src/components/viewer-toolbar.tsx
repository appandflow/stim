import { t } from '@lingui/core/macro';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/icon';
import { Touch } from '@/components/touch';
import { ViewerMenu } from '@/components/viewer-menu';

export interface ViewerAction {
  id: string;
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}

export type ViewerToolbarAction = ViewerAction | (Omit<ViewerAction, 'onPress'> & { actions: ViewerAction[] });

export function ViewerToolbar({ primary, secondary }: { primary: ViewerToolbarAction[]; secondary: ViewerAction[] }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.row}>
      <View style={styles.bar}>
        {primary.map((action) =>
          'actions' in action ? (
            <View key={action.id} style={styles.item}>
              <ViewerMenu actions={action.actions} label={action.label}>
                <View style={styles.item}>
                  <Icon name={action.icon} size={22} color={theme.media.text} />
                </View>
              </ViewerMenu>
            </View>
          ) : (
            <Touch
              key={action.id}
              onPress={action.onPress}
              disabled={action.disabled}
              defaultOpacity={action.disabled && !action.selected ? theme.opacity.disabled : 1}
              accessibilityLabel={action.label}
              accessibilityState={{ disabled: action.disabled === true, selected: action.selected === true }}
              style={[styles.item, styles.button(action.selected === true)]}
            >
              <Icon name={action.icon} size={22} color={theme.media.text} />
            </Touch>
          ),
        )}
        {secondary.length ? (
          <View style={styles.item}>
            <ViewerMenu actions={secondary} label={t`More`}>
              <View style={styles.item}>
                <Icon name="ellipsis" size={22} color={theme.media.text} />
              </View>
            </ViewerMenu>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    maxWidth: '100%',
    justifyContent: 'center',
    gap: theme.space.xs,
    padding: theme.space.xs,
    borderRadius: theme.radius.control,
    backgroundColor: theme.media.fill,
    borderWidth: 1,
    borderColor: theme.media.fillSubtle,
  },
  item: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  button: (selected: boolean) => ({
    borderRadius: theme.radius.control,
    backgroundColor: selected ? theme.media.fillSubtle : 'transparent',
  }),
}));
