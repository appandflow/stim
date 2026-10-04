import { t } from '@lingui/core/macro';
import { Image } from 'expo-image';
import { useRef, useState, type RefObject } from 'react';
import { Platform, TextInput, View, type TextInputInstance } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { ViewerBackdrop } from '@/components/viewer-backdrop';
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
  const extraKeys: [InputKey, string, string][] = [
    ['tab', t`Tab`, '\u21e5'],
    ['escape', t`Esc`, t`Esc`],
    ['backspace', t`Backspace`, '\u232b'],
    ['left', t`Left`, '\u2190'],
    ['up', t`Up`, '\u2191'],
    ['down', t`Down`, '\u2193'],
    ['right', t`Right`, '\u2192'],
  ];
  const shortcuts: [InputKey, string, string][] = [
    ['a', t`Select all`, 'selection.pin.in.out'],
    ['z', t`Undo`, 'arrow.uturn.backward'],
    ['s', t`Save`, 'square.and.arrow.down'],
    ['c', t`Copy`, 'document.on.document'],
    ['v', t`Paste`, 'document.on.clipboard'],
    ['x', t`Cut`, 'scissors'],
    ['f', t`Find`, 'magnifyingglass'],
  ];
  const modifierKeys: [KeyModifier, string, string][] = [
    ['shift', t`Shift`, '\u21e7'],
    ['control', t`Control`, '\u2303'],
    ['option', t`Option`, '\u2325'],
    ['command', t`Command`, '\u2318'],
  ];
  return (
    <KeyboardStickyView
      style={[styles.bar, { paddingLeft: insets.left, paddingRight: insets.right }, !shown && styles.hidden]}
      pointerEvents={shown ? 'auto' : 'none'}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
    >
      <ViewerBackdrop />
      {macos ? (
        <>
          <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={styles.keys}>
            {modifierKeys.map(([value, label, display]) => (
              <AccessoryKey
                key={value}
                label={label}
                display={display}
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
            {extraKeys.map(([value, label, display]) => (
              <AccessoryKey
                key={value}
                label={label}
                display={display}
                onPress={() => {
                  resetText();
                  key(value);
                }}
              />
            ))}
            {shortcuts.map(([value, label, symbol]) => (
              <AccessoryKey
                key={value}
                label={label}
                symbol={symbol}
                onPress={() => {
                  resetText();
                  key(value, ['command']);
                }}
              />
            ))}
          </ScrollView>
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
  display = label,
  symbol,
  selected = false,
  onPress,
}: {
  label: string;
  display?: string;
  symbol?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Touch
      hitSlop={4}
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={styles.key(selected)}
    >
      {symbol && Platform.OS === 'ios' ? (
        <Image source={`sf:${symbol}`} style={styles.symbol} tintColor={theme.media.text} accessible={false} />
      ) : (
        <Text variant="footnote" weight="semibold" style={[styles.keyText, { fontSize: display === label ? 14 : 18 }]}>
          {display}
        </Text>
      )}
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  hidden: { opacity: 0 },
  keys: {
    gap: theme.space.sm,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xs,
    alignItems: 'center',
  },
  key: (selected: boolean) => ({
    minHeight: 36,
    minWidth: 36,
    paddingHorizontal: theme.space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.control,
    backgroundColor: selected ? theme.colors.primary : theme.media.fill,
  }),
  symbol: { width: 18, height: 18 },
  keyText: { color: theme.media.text },
  note: { color: theme.media.text, paddingHorizontal: theme.space.md },
  inputRow: {
    minHeight: 44,
    paddingHorizontal: theme.space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
  },
  typed: {
    flex: 1,
    minHeight: 36,
    paddingHorizontal: theme.space.lg,
    borderRadius: theme.radius.control,
    backgroundColor: theme.media.fill,
    color: theme.media.text,
    fontSize: theme.typography.body.fontSize,
  },
  done: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
}));
