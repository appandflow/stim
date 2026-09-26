import type { SwitchProps } from '@expo/ui';
import { Row, Switch as ComposeSwitch, Text } from '@expo/ui/jetpack-compose';

// @expo/ui's Android Switch gives its label weight(1) (expo/expo#47088), which leaves it no width inside
// `Host matchContents`, so the label wraps one letter per line.
export function Switch({ label, value, onValueChange }: Pick<SwitchProps, 'label' | 'value' | 'onValueChange'>) {
  return (
    <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: 8 }}>
      <Text>{label}</Text>
      <ComposeSwitch value={value} onCheckedChange={onValueChange} />
    </Row>
  );
}
