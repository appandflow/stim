import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import { StimInstallTabs } from '@site/src/components/StimTabs';
import styles from './index.module.css';

function tiltIllustration({ currentTarget, clientX, clientY, pointerType }: PointerEvent<HTMLDivElement>) {
  if (
    pointerType !== 'mouse' ||
    !window.matchMedia('(prefers-reduced-motion: no-preference) and (hover: hover) and (pointer: fine)').matches
  ) {
    return;
  }

  const bounds = currentTarget.getBoundingClientRect();
  currentTarget.style.setProperty('--tilt-x', `${(0.5 - (clientY - bounds.top) / bounds.height) * 12}deg`);
  currentTarget.style.setProperty('--tilt-y', `${((clientX - bounds.left) / bounds.width - 0.5) * 12}deg`);
}

function resetTilt({ currentTarget }: PointerEvent<HTMLDivElement>) {
  currentTarget.style.removeProperty('--tilt-x');
  currentTarget.style.removeProperty('--tilt-y');
}

export default function Home(): ReactNode {
  const assetBase = useBaseUrl('/img/branding/');
  const contentRef = useRef<HTMLElement>(null);

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
      <main className={styles.content} ref={contentRef}>
        <header className={styles.hero}>
          <nav className={styles.nav} aria-label="Main navigation">
            <Link to="/" aria-label="Stim home" className={`${styles.logo} stim-logo`}>
              <img src={`${assetBase}logo.svg`} alt="" width="64" height="64" />
            </Link>
            <Link to="/docs/getting-started">Docs</Link>
            <Link to="/benchmarks">Benchmarks</Link>
            <a href="https://github.com/appandflow/stim" aria-label="Stim on GitHub" className={styles.github}>
              <img src={`${assetBase}github.svg`} alt="" width="16" height="16" />
              GitHub
            </a>
          </nav>
          <Heading as="h1">Fast, isolated React Native environments for agents</Heading>
          <p className={styles.lead}>
            Give each coding agent a fast, isolated React Native environment. Stim shares build caches across worktrees,
            owns each device and port, supports local and remote simulators, and cleans up when the work is done.
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
        <div
          className={styles.heroIllustration}
          data-reveal=""
          onPointerMove={tiltIllustration}
          onPointerLeave={resetTilt}
          onPointerCancel={resetTilt}
        >
          <img src={`${assetBase}hero.svg`} alt="" width="520" height="520" fetchPriority="high" />
        </div>
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
              <img src={`${assetBase}fast-builds.svg`} alt="" width="426" height="197" loading="lazy" />
            </div>
          </article>
          <article className={styles.feature}>
            <Heading as="h2">Parallel agents without collisions</Heading>
            <p>
              Each checkout gets its own Metro port and owned device. Agents can create isolated git worktrees and work
              in parallel. Small, streaming output and focused errors reduce waiting and token use.
            </p>
            <Link to="/docs/worktrees" aria-label="Read about isolated worktrees">
              View doc <span aria-hidden="true">&#8599;</span>
            </Link>
            <div className={styles.parallelIllustration} data-reveal="">
              <img src={`${assetBase}parallel-agents.svg`} alt="" width="320" height="424" loading="lazy" />
            </div>
          </article>
          <article className={styles.feature}>
            <Heading as="h2">React Native and Expo, here or remote</Heading>
            <p>
              Stim works with React Native Community CLI and Expo projects. It builds locally, then launches on an owned
              simulator or emulator, connected phone, or configured remote device. The agent gets the exact device and
              launch state.
            </p>
            <Link to="/docs/owned-devices" aria-label="Read about supported devices">
              View doc <span aria-hidden="true">&#8599;</span>
            </Link>
          </article>
          <article className={styles.feature}>
            <Heading as="h2">Owned resources and complete cleanup</Heading>
            <p>
              Stim tracks every port, process, build, device, and remote session it creates. <code>stop</code>,{' '}
              <code>worktree remove</code>, and <code>gc</code> reclaim resources without touching devices Stim does not
              own.
            </p>
            <Link to="/docs/commands" aria-label="Read about cleanup commands">
              View doc <span aria-hidden="true">&#8599;</span>
            </Link>
          </article>
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
        <footer className={styles.footer}>
          <nav aria-label="Footer navigation">
            <Link to="/docs/why">Why Stim</Link>
            <Link to="/docs/changelog">Changelog</Link>
            <a href="https://www.npmjs.com/package/stim-cli">npm</a>
          </nav>
          <p>
            MIT License. Built by <a href="https://appandflow.com">AppAndFlow</a>.
          </p>
        </footer>
      </main>
    </Layout>
  );
}
