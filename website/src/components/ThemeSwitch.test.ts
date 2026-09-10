/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ThemeSwitch from './ThemeSwitch';

const theme = vi.hoisted(() => ({ colorMode: 'light', setColorMode: vi.fn<(mode: string) => void>() }));
vi.mock('@docusaurus/theme-common', () => ({ useColorMode: () => theme }));

describe('ThemeSwitch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    theme.colorMode = 'light';
    theme.setColorMode.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(ThemeSwitch)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  });

  test('switches to the opposite color mode', () => {
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-checked')).toBe('false');
    act(() => button.click());
    expect(theme.setColorMode).toHaveBeenCalledWith('dark');

    theme.colorMode = 'dark';
    act(() => root.render(createElement(ThemeSwitch)));
    expect(button.getAttribute('aria-checked')).toBe('true');
    act(() => button.click());
    expect(theme.setColorMode).toHaveBeenLastCalledWith('light');
  });
});
