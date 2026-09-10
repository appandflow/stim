import type { ReactNode } from 'react';
import { useColorMode } from '@docusaurus/theme-common';
import useIsBrowser from '@docusaurus/useIsBrowser';
import styles from './ThemeSwitch.module.css';

export default function ThemeSwitch(): ReactNode {
  const { colorMode, setColorMode } = useColorMode();
  const isBrowser = useIsBrowser();

  return (
    <button
      type="button"
      role="switch"
      aria-label="Dark mode"
      aria-checked={colorMode === 'dark'}
      disabled={!isBrowser}
      onClick={() => setColorMode(colorMode === 'dark' ? 'light' : 'dark')}
      className={styles.toggle}
    >
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  );
}
