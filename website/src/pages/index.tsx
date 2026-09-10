import { useEffect, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import ThemedImage from '@theme/ThemedImage';
import { StimInstallTabs } from '@site/src/components/StimTabs';
import ThemeSwitch from '@site/src/components/ThemeSwitch';
import { canTilt } from '../components/canTilt';
import styles from './index.module.css';

function tapIllustration({ currentTarget, clientX, clientY, detail }: MouseEvent<HTMLButtonElement>) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const illustration = currentTarget.querySelector('img')!;
  const { x, y } = detail === 0 ? { x: -4, y: 4 } : canTilt(currentTarget.getBoundingClientRect(), clientX, clientY);
  const angle = Math.hypot(x, y);
  for (const animation of illustration.getAnimations()) animation.cancel();
  illustration.animate(
    { rotate: ['0deg', `${x} ${y} 0 ${angle}deg`, `${x} ${y} 0 ${-angle / 3}deg`, '0deg'] },
    { duration: 600, easing: 'ease-in-out' },
  );
}

export default function Home(): ReactNode {
  const assetBase = useBaseUrl('/img/branding/');
  const contentRef = useRef<HTMLDivElement>(null);
  const tilt = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, frame: null as number | null });

  useEffect(() => {
    const motion = tilt.current;
    return () => {
      if (motion.frame !== null) cancelAnimationFrame(motion.frame);
      motion.frame = null;
    };
  }, []);

  function setTilt(element: HTMLButtonElement, x: number, y: number) {
    const motion = tilt.current;
    motion.targetX = x;
    motion.targetY = y;
    if (motion.frame !== null) return;

    let previousTime: number | undefined;
    function animate(time: number) {
      previousTime ??= time;
      const blend = 1 - Math.exp(-(time - previousTime) / 60);
      previousTime = time;
      motion.x += (motion.targetX - motion.x) * blend;
      motion.y += (motion.targetY - motion.y) * blend;
      const settled = Math.hypot(motion.targetX - motion.x, motion.targetY - motion.y) < 0.01;
      if (settled) {
        motion.x = motion.targetX;
        motion.y = motion.targetY;
      }
      element.style.setProperty('--tilt-x', `${motion.x}deg`);
      element.style.setProperty('--tilt-y', `${motion.y}deg`);
      motion.frame = settled ? null : requestAnimationFrame(animate);
    }
    motion.frame = requestAnimationFrame(animate);
  }

  function tiltIllustration({ currentTarget, clientX, clientY, pointerType }: PointerEvent<HTMLButtonElement>) {
    if (
      pointerType !== 'mouse' ||
      !window.matchMedia('(prefers-reduced-motion: no-preference) and (hover: hover) and (pointer: fine)').matches
    ) {
      return;
    }

    const { x, y } = canTilt(currentTarget.getBoundingClientRect(), clientX, clientY);
    setTilt(currentTarget, x, y);
  }

  function resetTilt({ currentTarget }: PointerEvent<HTMLButtonElement>) {
    setTilt(currentTarget, 0, 0);
  }

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.reveal = 'visible';
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1 },
    );

    for (const illustration of contentRef.current!.querySelectorAll<HTMLElement>('[data-reveal]')) {
      if (illustration.getBoundingClientRect().top >= window.innerHeight) {
        illustration.dataset.reveal = 'pending';
        observer.observe(illustration);
      }
    }

    return () => observer.disconnect();
  }, []);

  return (
    <Layout
      noFooter
      wrapperClassName={styles.page}
      description="Stim gives coding agents fast, isolated React Native and Expo environments with shared build caches and owned devices."
    >
      <div className={styles.content} ref={contentRef}>
        <nav className={styles.nav} aria-label="Main navigation">
          <Link to="/" aria-label="Stim home" className={`${styles.logo} stim-logo`}>
            <ThemedImage
              sources={{ light: `${assetBase}logo.svg`, dark: `${assetBase}logo-dark.svg` }}
              alt=""
              width="48"
              height="48"
            />
          </Link>
          <Link to="/docs/getting-started">Docs</Link>
          <Link to="/benchmarks">Benchmarks</Link>
          <a href="https://github.com/appandflow/stim" aria-label="Stim on GitHub">
            GitHub
          </a>
          <ThemeSwitch />
        </nav>
        <main>
          <header className={styles.hero}>
            <Heading as="h1">Fast, isolated React Native environments for agents</Heading>
            <p className={styles.lead}>
              Give each coding agent a fast, isolated React Native environment. Stim shares build caches across
              worktrees, owns each device and port, supports local and remote simulators, and cleans up when the work is
              done.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primaryButton} to="/docs/getting-started">
                Get started
              </Link>
              <div className={styles.install}>
                <StimInstallTabs />
              </div>
            </div>
          </header>
          <button
            type="button"
            aria-label="Tilt the Stim can"
            className={styles.heroIllustration}
            data-reveal=""
            onClick={tapIllustration}
            onContextMenu={(event) => event.preventDefault()}
            onPointerMove={tiltIllustration}
            onPointerLeave={resetTilt}
            onPointerCancel={resetTilt}
          >
            <ThemedImage
              sources={{ light: `${assetBase}hero.svg`, dark: `${assetBase}hero-dark.svg` }}
              alt=""
              width="520"
              height="520"
              fetchPriority="high"
              draggable={false}
            />
          </button>
          <section aria-label="Features" className={styles.features}>
            <article className={styles.feature}>
              <Heading as="h2">Fast builds across worktrees</Heading>
              <p>
                Native artifacts, Xcode compilation data, Gradle output, and Metro transforms are shared safely. A new
                worktree can install a cached app when its native inputs match. Concurrent misses use one build.
              </p>
              <Link to="/docs/build-caches" aria-label="Read about build caches">
                View doc <span aria-hidden="true">&#8599;</span>
              </Link>
              <div className={styles.fastIllustration} data-reveal="">
                <ThemedImage
                  sources={{ light: `${assetBase}fast-builds.svg`, dark: `${assetBase}fast-builds-dark.svg` }}
                  alt=""
                  width="448"
                  height="250"
                  loading="lazy"
                />
              </div>
            </article>
            <article className={styles.feature}>
              <Heading as="h2">Parallel agents without collisions</Heading>
              <p>
                Each checkout gets its own Metro port and owned device. Agents can create isolated git worktrees and
                work in parallel. Small, streaming output and focused errors reduce waiting and token use.
              </p>
              <Link to="/docs/worktrees" aria-label="Read about isolated worktrees">
                View doc <span aria-hidden="true">&#8599;</span>
              </Link>
              <div className={styles.parallelIllustration} data-reveal="">
                <ThemedImage
                  sources={{ light: `${assetBase}parallel-agents.svg`, dark: `${assetBase}parallel-agents-dark.svg` }}
                  alt=""
                  width="324"
                  height="298"
                  loading="lazy"
                />
              </div>
            </article>
            <article className={styles.feature}>
              <Heading as="h2">React Native and Expo, here or remote</Heading>
              <p>
                Stim works with React Native Community CLI and Expo projects. It builds locally, then launches on an
                owned simulator or emulator, connected phone, or configured remote device. The agent gets the exact
                device and launch state.
              </p>
              <Link to="/docs/owned-devices" aria-label="Read about supported devices">
                View doc <span aria-hidden="true">&#8599;</span>
              </Link>
              <div className={styles.deviceIllustration} data-reveal="">
                <ThemedImage
                  sources={{
                    light: `${assetBase}react-native-expo.svg`,
                    dark: `${assetBase}react-native-expo-dark.svg`,
                  }}
                  alt=""
                  width="386"
                  height="248"
                  loading="lazy"
                />
              </div>
            </article>
            <article className={styles.feature}>
              <Heading as="h2">Owned resources and complete cleanup</Heading>
              <p>
                Stim tracks every port, process, build, device, and remote session it creates. <code>stop</code>,{' '}
                <code>worktree remove</code>, and <code>gc</code> reclaim resources without touching devices Stim does
                not own.
              </p>
              <Link to="/docs/commands" aria-label="Read about cleanup commands">
                View doc <span aria-hidden="true">&#8599;</span>
              </Link>
              <div className={styles.cleanupIllustration} data-reveal="">
                <ThemedImage
                  sources={{ light: `${assetBase}cleanup.svg`, dark: `${assetBase}cleanup-dark.svg` }}
                  alt=""
                  width="338"
                  height="433"
                  loading="lazy"
                />
              </div>
            </article>
          </section>
          <section className={styles.why} aria-labelledby="why-stim">
            <Heading as="h2" id="why-stim">
              Why Stim
            </Heading>
            <p>
              React Native toolchains were built for one developer working in one checkout. Coding agents often work
              across several worktrees at once. Stim lets those worktrees share build work while keeping their devices,
              ports, and running apps separate.
            </p>
            <Link to="/docs/why">
              More about Stim <span aria-hidden="true">&#8599;</span>
            </Link>
          </section>
          <section className={styles.agentSetup} aria-labelledby="agent-setup">
            <Heading as="h2" id="agent-setup">
              Give your agent the skill
            </Heading>
            <CodeBlock language="bash">npx skills add appandflow/stim</CodeBlock>
            <p>Then ask your agent: &quot;Build and run the app on iOS.&quot;</p>
            <p>Stim needs no initialization. Runtime state stays outside the project.</p>
            <Link to="/docs/agent-skills">
              Agent setup <span aria-hidden="true">&#8599;</span>
            </Link>
          </section>
        </main>
        <footer className={styles.footer}>
          <p>
            Made by{' '}
            <a href="https://appandflow.com" target="_blank" rel="noopener noreferrer">
              App&amp;Flow
            </a>{' '}
            &middot; MIT License
          </p>
        </footer>
        <div className={styles.abstractIllustration} data-reveal="">
          <ThemedImage
            sources={{ light: `${assetBase}abstract.svg`, dark: `${assetBase}abstract-dark.svg` }}
            alt=""
            width="520"
            height="520"
            loading="lazy"
          />
        </div>
      </div>
    </Layout>
  );
}
