import { useRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useColorMode } from '@docusaurus/theme-common';
import useIsBrowser from '@docusaurus/useIsBrowser';
import styles from './ThemeSwitch.module.css';

export default function ThemeSwitch(): ReactNode {
  const { colorMode, setColorMode } = useColorMode();
  const isBrowser = useIsBrowser();
  const transitioning = useRef(false);

  function toggle() {
    if (transitioning.current) return;
    const nextMode = colorMode === 'dark' ? 'light' : 'dark';
    if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setColorMode(nextMode);
      return;
    }

    transitioning.current = true;
    document.documentElement.classList.add('stim-theme-transition');
    const transition = document.startViewTransition(() => flushSync(() => setColorMode(nextMode)));
    void transition.finished.finally(() => {
      document.documentElement.classList.remove('stim-theme-transition');
      transitioning.current = false;
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-label="Dark mode"
      aria-checked={colorMode === 'dark'}
      disabled={!isBrowser}
      onClick={toggle}
      className={styles.toggle}
    >
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  );
}
