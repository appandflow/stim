import { Host } from '@expo/ui';
import { Button, Menu, RNHostView } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled } from '@expo/ui/swift-ui/modifiers';
import type { ReactElement } from 'react';

import type { ViewerAction } from '@/components/viewer-toolbar';

export function ViewerMenu({
  actions,
  label,
  children,
}: {
  actions: ViewerAction[];
  label: string;
  children: ReactElement;
}) {
  return (
    <Host matchContents={{ vertical: true }} style={{ width: '100%' }}>
      <Menu label={<RNHostView matchContents>{children}</RNHostView>} modifiers={[accessibilityLabel(label)]}>
        {actions.map((action) => (
          <Button
            key={action.id}
            label={action.label}
            systemImage={action.selected ? 'checkmark' : action.icon}
            modifiers={[disabled(action.disabled === true)]}
            onPress={action.onPress}
          />
        ))}
      </Menu>
    </Host>
  );
}
