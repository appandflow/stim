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
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
    Object.defineProperty(document, 'startViewTransition', { configurable: true, get: () => undefined });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(ThemeSwitch)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, 'startViewTransition');
    document.documentElement.classList.remove('stim-theme-transition');
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  });

  test('changes theme directly when view transitions are unavailable', () => {
    act(() => container.querySelector('button')!.click());
    expect(theme.setColorMode).toHaveBeenCalledWith('dark');
    expect(document.documentElement.classList.contains('stim-theme-transition')).toBe(false);
  });

  test('skips motion when reduced motion is requested', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    const start = vi.fn<() => void>();
    Object.defineProperty(document, 'startViewTransition', { configurable: true, get: () => start });
    act(() => container.querySelector('button')!.click());
    expect(theme.setColorMode).toHaveBeenCalledWith('dark');
    expect(start).not.toHaveBeenCalled();
  });

  test('blocks overlapping reveals and clears the transition after completion', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const start = vi.fn<(update: () => void) => { finished: Promise<void> }>((update) => {
      update();
      return { finished };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, get: () => start });
    act(() => {
      container.querySelector('button')!.click();
      container.querySelector('button')!.click();
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(theme.setColorMode).toHaveBeenCalledWith('dark');
    expect(document.documentElement.classList.contains('stim-theme-transition')).toBe(true);
    await act(async () => {
      finish();
      await finished;
    });
    expect(document.documentElement.classList.contains('stim-theme-transition')).toBe(false);
    theme.colorMode = 'dark';
    act(() => root.render(createElement(ThemeSwitch)));
    expect(container.querySelector('button')!.getAttribute('aria-checked')).toBe('true');
    act(() => container.querySelector('button')!.click());
    expect(start).toHaveBeenCalledTimes(2);
    expect(theme.setColorMode).toHaveBeenLastCalledWith('light');
    await act(async () => {
      await finished;
    });
  });
});
