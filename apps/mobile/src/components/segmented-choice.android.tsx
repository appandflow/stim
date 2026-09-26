import type { SegmentedControlProps } from '@expo/ui/community/segmented-control';
import { SegmentedButton, SingleChoiceSegmentedButtonRow, Text } from '@expo/ui/jetpack-compose';
import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers';

// The @expo/ui drop-in SegmentedControl wraps its buttons in its own Host. Inside a Compose
// FieldGroup that nested Host is skipped by the enclosing composition, so on Android the
// buttons are composed directly into the caller's Host.
export function SegmentedChoice({ values = [], selectedIndex, onValueChange }: SegmentedControlProps) {
  return (
    <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
      {values.map((label, index) => (
        <SegmentedButton key={label} selected={index === selectedIndex} onClick={() => onValueChange?.(label)}>
          <SegmentedButton.Label>
            <Text>{label}</Text>
          </SegmentedButton.Label>
        </SegmentedButton>
      ))}
    </SingleChoiceSegmentedButtonRow>
  );
}
