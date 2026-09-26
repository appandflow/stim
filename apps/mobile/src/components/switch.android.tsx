import type { SwitchProps } from '@expo/ui';
import { Row, Switch as ComposeSwitch, Text } from '@expo/ui/jetpack-compose';
import { testID as testIDModifier } from '@expo/ui/jetpack-compose/modifiers';

// @expo/ui's Android Switch gives its label weight(1) (expo/expo#47088), which leaves it no width inside
// `Host matchContents`, so the label wraps one letter per line.
export function Switch({ value, onValueChange, label, disabled, testID, modifiers }: SwitchProps) {
  const toggle = (
    <ComposeSwitch
      value={value}
      onCheckedChange={disabled ? undefined : onValueChange}
      enabled={!disabled}
      modifiers={[...(modifiers ?? []), ...(testID ? [testIDModifier(testID)] : [])]}
    />
  );
  if (label == null) return toggle;
  return (
    <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: 8 }}>
      <Text>{label}</Text>
      {toggle}
    </Row>
  );
}
