import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useColorMode } from '@docusaurus/theme-common';
import ThemedImage from '@theme/ThemedImage';

export default function HeroJar({ assetBase, className }: { assetBase: string; className: string }): ReactNode {
  const { colorMode } = useColorMode();
  const containerRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let animation: import('lottie-web').AnimationItem | undefined;
    let cancelled = false;
    void (async () => {
      const { default: lottie } = await import('lottie-web/build/player/lottie_light');
      if (cancelled) return;
      animation = lottie.loadAnimation({
        container: containerRef.current!,
        renderer: 'svg',
        loop: true,
        autoplay: false,
        path: `${assetBase}stim-jar-${colorMode}.json`,
      });
      animation.addEventListener('DOMLoaded', () => {
        animation!.goToAndPlay(frameRef.current, true);
        setPlaying(true);
      });
    })();

    return () => {
      cancelled = true;
      if (animation) frameRef.current = animation.currentFrame;
      animation?.destroy();
      setPlaying(false);
    };
  }, [assetBase, colorMode]);

  return (
    <span className={className} data-playing={playing || undefined}>
      <ThemedImage
        sources={{ light: `${assetBase}stim-jar-light.svg`, dark: `${assetBase}stim-jar-dark.svg` }}
        alt=""
        width="278"
        height="450"
        fetchPriority="high"
        draggable={false}
      />
      <span ref={containerRef} />
    </span>
  );
}
