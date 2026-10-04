import { t } from '@lingui/core/macro';
import { useRef, useState, type RefObject } from 'react';
import { TextInput, View, type TextInputInstance } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';
import { keyboardDelta } from '@/lib/device-control';
import type { InputKey, KeyModifier } from '@/protocol/types';

export function ViewerKeyboard({
  keyboard,
  shown,
  macos,
  extendedKeys,
  onFocus,
  onBlur,
  onHeight,
  text,
  onKey: send,
}: {
  keyboard: RefObject<TextInputInstance | null>;
  shown: boolean;
  macos: boolean;
  extendedKeys: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onHeight: (height: number) => void;
  text: (value: string) => void;
  onKey: (key: InputKey, modifiers?: KeyModifier[]) => void;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [typed, setTyped] = useState('');
  const previousText = useRef('');
  const [modifiers, setModifiers] = useState<KeyModifier[]>([]);
  const pendingModifiers = useRef<KeyModifier[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const selectModifiers = (next: KeyModifier[]) => {
    pendingModifiers.current = next;
    setModifiers(next);
  };
  const resetText = () => {
    previousText.current = '';
    keyboard.current?.clear();
    setTyped('');
  };
  const key = (value: InputKey, fixed?: KeyModifier[]) => {
    send(value, fixed ?? pendingModifiers.current);
    selectModifiers([]);
    setNote(null);
  };
  const extraKeys: [InputKey, string][] = [
    ['tab', t`Tab`],
    ['escape', t`Esc`],
    ['backspace', t`Backspace`],
    ['left', t`Left`],
    ['up', t`Up`],
    ['down', t`Down`],
    ['right', t`Right`],
  ];
  const shortcuts: [InputKey, string][] = [
    ['a', t`Select all`],
    ['z', t`Undo`],
    ['s', t`Save`],
    ['c', t`Copy`],
    ['v', t`Paste`],
    ['x', t`Cut`],
    ['f', t`Find`],
  ];
  const modifierKeys: [KeyModifier, string][] = [
    ['shift', t`Shift`],
    ['control', t`Control`],
    ['option', t`Option`],
    ['command', t`Command`],
  ];
  return (
    <KeyboardStickyView
      style={[styles.bar, { paddingLeft: insets.left, paddingRight: insets.right }, !shown && styles.hidden]}
      pointerEvents={shown ? 'auto' : 'none'}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
    >
      {macos ? (
        <>
          <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={styles.keys}>
            {modifierKeys.map(([value, label]) => (
              <AccessoryKey
                key={value}
                label={label}
                selected={modifiers.includes(value)}
                onPress={() => {
                  setNote(null);
                  selectModifiers(
                    pendingModifiers.current.includes(value)
                      ? pendingModifiers.current.filter((entry) => entry !== value)
                      : [...pendingModifiers.current, value],
                  );
                }}
              />
            ))}
            {extraKeys.map(([value, label]) => (
              <AccessoryKey
                key={value}
                label={label}
                onPress={() => {
                  resetText();
                  key(value);
                }}
              />
            ))}
          </ScrollView>
          <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={styles.keys}>
            {shortcuts.map(([value, label]) => (
              <AccessoryKey
                key={value}
                label={label}
                onPress={() => {
                  resetText();
                  key(value, ['command']);
                }}
              />
            ))}
          </ScrollView>
          <Text variant="footnote" style={styles.note}>
            {t`Mac letter shortcuts require the Mac's U.S. or ABC keyboard layout.`}
          </Text>
          {note ? (
            <Text variant="footnote" style={styles.note} accessibilityLiveRegion="polite">
              {note}
            </Text>
          ) : null}
        </>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          ref={keyboard}
          style={styles.typed}
          placeholder={t`Type on the device`}
          placeholderTextColor={withAlpha(theme.media.text, theme.opacity.disabled)}
          value={typed}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          keyboardType="ascii-capable"
          disableFullscreenUI
          submitBehavior="submit"
          onChangeText={(next) => {
            const delta = keyboardDelta(previousText.current, next);
            previousText.current = next;
            setTyped(next);
            if (!delta) return;
            const selected = pendingModifiers.current;
            if (macos && selected.length) {
              if (delta === '\b') {
                key('backspace');
                return;
              }
              if (extendedKeys && /^[a-z0-9]$/i.test(delta)) {
                key(
                  delta.toLowerCase() as InputKey,
                  /^[A-Z]$/.test(delta) && !selected.includes('shift') ? [...selected, 'shift'] : selected,
                );
                return;
              }
              resetText();
              setNote(
                extendedKeys
                  ? t`Modifiers apply to one letter or digit at a time. Use the extra keys for navigation.`
                  : t`Update Stim on the Mac to use modifiers with letters and digits. The extra keys and shortcuts still work.`,
              );
              return;
            }
            if (delta) text(delta);
          }}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === 'Backspace' && previousText.current === '') {
              if (macos && pendingModifiers.current.length) key('backspace');
              else text('\b');
            }
          }}
          onSubmitEditing={() => {
            resetText();
            if (macos && pendingModifiers.current.length) key('return');
            else text('\n');
          }}
          onFocus={onFocus}
          onBlur={() => {
            selectModifiers([]);
            setNote(null);
            onBlur();
          }}
          accessibilityLabel={t`Type on the device`}
        />
        <Touch onPress={() => keyboard.current?.blur()} style={styles.done}>
          <Text weight="semibold" tone="brand">{t`Done`}</Text>
        </Touch>
      </View>
    </KeyboardStickyView>
  );
}

function AccessoryKey({
  label,
  selected = false,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Touch onPress={onPress} accessibilityLabel={label} accessibilityState={{ selected }} style={styles.key(selected)}>
      <Text variant="callout" weight="semibold" style={styles.keyText}>
        {label}
      </Text>
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: theme.media.bar },
  hidden: { opacity: 0 },
  keys: {
    gap: theme.space.xs,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.xs,
    alignItems: 'center',
  },
  key: (selected: boolean) => ({
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: theme.space.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.control,
    backgroundColor: selected ? theme.colors.primary : theme.media.fill,
  }),
  keyText: { color: theme.media.text },
  note: { color: theme.media.text, paddingHorizontal: theme.space.md },
  inputRow: {
    minHeight: 56,
    paddingHorizontal: theme.space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
  },
  typed: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: theme.space.lg,
    borderRadius: theme.radius.control,
    backgroundColor: theme.media.fill,
    color: theme.media.text,
    fontSize: theme.typography.body.fontSize,
  },
  done: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
}));
