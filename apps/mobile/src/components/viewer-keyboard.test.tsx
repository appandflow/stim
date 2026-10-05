import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { createRef } from 'react';
import type { TextInputInstance } from 'react-native';

import '@/design/unistyles';

import { ViewerKeyboard } from './viewer-keyboard';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ left: 0, right: 0 }) }));
jest.mock('@/components/touch', () => ({
  Touch: (props: object) => {
    const { Pressable } = jest.requireActual('react-native');
    return <Pressable {...props} />;
  },
}));

async function keyboard(extendedKeys = true) {
  const text = jest.fn();
  const key = jest.fn();
  const screen = await render(
    <GestureHandlerRootView>
      <I18nProvider i18n={i18n}>
        <ViewerKeyboard
          keyboard={createRef<TextInputInstance>()}
          shown
          macos
          extendedKeys={extendedKeys}
          onFocus={jest.fn()}
          onBlur={jest.fn()}
          onHeight={jest.fn()}
          text={text}
          onKey={key}
        />
      </I18nProvider>
    </GestureHandlerRootView>,
  );
  return { screen, text, key };
}

test('a selected modifier applies to the next letter, then ordinary typing uses text', async () => {
  const { screen, text, key } = await keyboard();
  await fireEvent.press(screen.getByLabelText('Command'));
  expect(screen.getByLabelText('Command').props.accessibilityState.selected).toBe(true);
  await fireEvent.changeText(screen.getByLabelText('Type on the device'), 'l');
  expect(key).toHaveBeenCalledWith('l', ['command']);
  expect(text).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Command').props.accessibilityState.selected).toBe(false);
  await fireEvent.changeText(screen.getByLabelText('Type on the device'), 'lhello');
  expect(text).toHaveBeenCalledWith('hello');
});

test('combined modifiers and uppercase typing are preserved for one key', async () => {
  const { screen, key } = await keyboard();
  await fireEvent.press(screen.getByLabelText('Control'));
  await fireEvent.press(screen.getByLabelText('Option'));
  await fireEvent.changeText(screen.getByLabelText('Type on the device'), 'B');
  expect(key).toHaveBeenCalledWith('b', ['control', 'option', 'shift']);
  expect(screen.getByLabelText('Control').props.accessibilityState.selected).toBe(false);
  await fireEvent.press(screen.getByLabelText('Shift'));
  await fireEvent.press(screen.getByLabelText('Left'));
  expect(key).toHaveBeenLastCalledWith('left', ['shift']);
});

test('an older server gets fixed shortcuts but no unsupported modified letter', async () => {
  const { screen, text, key } = await keyboard(false);
  await fireEvent.press(screen.getByLabelText('Command'));
  await fireEvent.changeText(screen.getByLabelText('Type on the device'), 'l');
  expect(key).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
  expect(screen.getByText(/Update Stim on the Mac/)).toBeTruthy();
  expect(screen.getByLabelText('Command').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(screen.getByLabelText('Select all'));
  expect(key).toHaveBeenCalledWith('a', ['command']);
  expect(screen.getByLabelText('Command').props.accessibilityState.selected).toBe(false);
});

test('modified paste is refused, and keyboard dismissal clears modifiers', async () => {
  const { screen, text, key } = await keyboard();
  await fireEvent.press(screen.getByLabelText('Command'));
  await fireEvent.changeText(screen.getByLabelText('Type on the device'), 'paste');
  expect(text).not.toHaveBeenCalled();
  expect(key).not.toHaveBeenCalled();
  expect(screen.getByText(/Modifiers apply to one letter/)).toBeTruthy();
  await fireEvent(screen.getByLabelText('Type on the device'), 'blur');
  await fireEvent.changeText(screen.getByLabelText('Type on the device'), 'x');
  expect(text).toHaveBeenCalledWith('x');
  expect(key).not.toHaveBeenCalled();
});

test('queued native text callbacks do not duplicate text or reuse a one-shot modifier', async () => {
  const { screen, text, key } = await keyboard();
  await fireEvent.changeText(screen.getByLabelText('Type on the device'), 'he');
  text.mockClear();
  const change = screen.getByLabelText('Type on the device').props.onChangeText;
  await act(async () => {
    change('hel');
    change('hell');
  });
  expect(text.mock.calls).toEqual([['l'], ['l']]);
  await fireEvent.press(screen.getByLabelText('Command'));
  const modified = screen.getByLabelText('Type on the device').props.onChangeText;
  await act(async () => {
    modified('hell');
    modified('hellq');
    modified('hellqx');
  });
  expect(key.mock.calls).toEqual([['q', ['command']]]);
  expect(text).toHaveBeenLastCalledWith('x');
});
