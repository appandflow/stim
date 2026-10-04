import { Host } from '@expo/ui';
import { DropdownMenu, DropdownMenuItem, Text as NativeText } from '@expo/ui/jetpack-compose';
import { useState, type ReactElement } from 'react';

import { Touch } from '@/components/touch';
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
  const [open, setOpen] = useState(false);
  return (
    <Host matchContents={{ vertical: true }} style={{ width: '100%' }}>
      <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)}>
        <DropdownMenu.Trigger>
          <Touch onPress={() => setOpen(true)} accessibilityLabel={label} accessibilityState={{ expanded: open }}>
            {children}
          </Touch>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.id}
              enabled={!action.disabled}
              onClick={() => {
                setOpen(false);
                action.onPress();
              }}
            >
              <DropdownMenuItem.Text>
                <NativeText>{action.label}</NativeText>
              </DropdownMenuItem.Text>
              {action.selected ? (
                <DropdownMenuItem.TrailingIcon>
                  <NativeText>{'\u2713'}</NativeText>
                </DropdownMenuItem.TrailingIcon>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}
