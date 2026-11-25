import { useEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import ThemedImage from '@theme/ThemedImage';
import { StimInstallTabs } from '@site/src/components/StimTabs';
import HeroJar from '@site/src/components/HeroJar';
import ThemeSwitch from '@site/src/components/ThemeSwitch';
import { canTilt } from '../components/canTilt';
import styles from './index.module.css';

const desktopDownloadUrl = 'https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg';

const launchOutput = `$ stim ios
OK: com.acme.shop on stim-shop (iPhone 17 26.5), Metro port 8083 (from cache)
  device      stim-shop (iPhone 17 26.5)
  app         com.acme.shop
  metro       running on port 8083
  cache       from cache
  logs        ~/.stim/workspaces/shop--3f9c2a1b/logs`;

type Pillar = {
  title: string;
  body: string;
  doc: string;
  docLabel: string;
  art: string;
  width: number;
  height: number;
};

const pillars: Pillar[] = [
  {
    title: 'Worktree-based workflow',
    body: 'One git worktree per task. Stim warms its dependencies and gives it its own Metro port and device, so parallel agents never collide.',
    doc: '/docs/worktrees',
    docLabel: 'Read about worktrees',
    art: 'parallel-agents',
    width: 324,
    height: 298,
  },
  {
    title: 'Builds you only pay for once',
    body: 'React Native, Expo, Xcode and Gradle builds are cached and shared across worktrees, so a new one rarely compiles from scratch.',
    doc: '/docs/build-caches',
    docLabel: 'Read about build caches',
    art: 'fast-builds',
    width: 448,
    height: 250,
  },
  {
    title: 'Every device, every machine',
    body: 'Simulators, emulators, connected phones, other Macs, EAS and CI. Send builds to another machine when this one is busy.',
    doc: '/docs/remote-machines',
    docLabel: 'Read about remote machines',
    art: 'react-native-expo',
    width: 386,
    height: 248,
  },
  {
    title: 'Watches the whole machine',
    body: 'Concurrency limits make builds, devices and test runs wait their turn instead of overloading the machine. When disk or memory runs low, Stim frees space.',
    doc: '/docs/build-caches#automatic-maintenance',
    docLabel: 'Read about automatic maintenance',
    art: 'cleanup',
    width: 338,
    height: 433,
  },
];

const frameworks = [
  { name: 'Expo', detail: 'Expo apps', logo: 'expo', width: 26 },
  { name: 'React Native', detail: 'React Native CLI and Re.Pack apps', logo: 'react', width: 28 },
  { name: 'Xcode', detail: 'Native Xcode apps', logo: 'apple', width: 24 },
  { name: 'Gradle', detail: 'Native Gradle apps', logo: 'android', width: 28 },
  { name: 'Exact', detail: 'Exact apps', logo: 'exact', width: 34 },
  { name: 'Web', detail: 'Web pages in an owned Chrome', logo: 'web', width: 26 },
];

function tapIllustration({ currentTarget, clientX, clientY, detail }: MouseEvent<HTMLButtonElement>) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const illustration = currentTarget.firstElementChild!;
  const { x, y } = detail === 0 ? { x: -4, y: 4 } : canTilt(currentTarget.getBoundingClientRect(), clientX, clientY);
  const angle = Math.hypot(x, y);
  for (const animation of illustration.getAnimations()) animation.cancel();
  illustration.animate(
    { rotate: ['0deg', `${x} ${y} 0 ${angle}deg`, `${x} ${y} 0 ${-angle / 3}deg`, '0deg'] },
    { duration: 600, easing: 'ease-in-out' },
  );
}

function DocLink({ to, label, children }: { to: string; label?: string; children: ReactNode }) {
  return (
    <Link to={to} aria-label={label} className={styles.docLink}>
      {children} <span aria-hidden="true">&#8599;</span>
    </Link>
  );
}

export default function Home(): ReactNode {
  const assetBase = useBaseUrl('/img/branding/');
  const desktopBase = useBaseUrl('/img/desktop/');
  const frameworkBase = useBaseUrl('/img/frameworks/');
  const contentRef = useRef<HTMLDivElement>(null);
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
      description="Stim runs React Native, Expo and native apps for coding agents, in parallel, on every device and machine you have."
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
          <Link to="/docs/changelog" className={styles.navOptional}>
            Changelog
          </Link>
          <Link to="/docs/desktop#download">Download</Link>
          <a href="https://github.com/appandflow/stim" aria-label="Stim on GitHub">
            GitHub
          </a>
          <ThemeSwitch />
        </nav>
        <main>
          <header className={styles.hero}>
            <div className={styles.heroText}>
              <p className={styles.eyebrow}>For React Native, Expo and native apps</p>
              <Heading as="h1">Orchestrate fast builds and devices for coding agents</Heading>
              <p className={styles.lead}>
                Stim builds, launches and cleans up your app for every agent, locally or across your machines, and shows
                you what each one is running.
              </p>
              <div className={styles.buttons}>
                <Link className={`${styles.primaryButton} stim-squish`} to="/docs/getting-started">
                  Get started
                </Link>
                <a className={`${styles.secondaryButton} stim-squish`} href={desktopDownloadUrl}>
                  Download for Mac
                </a>
              </div>
              <p className={styles.downloadNote}>
                Stim Desktop &middot; macOS 14+ &middot; Apple silicon &amp; Intel &middot;{' '}
                <Link to="/docs/desktop#download">Details</Link>
              </p>
              <div className={styles.install}>
                <StimInstallTabs />
              </div>
            </div>
            <button
              type="button"
              aria-label="Tilt the Stim can"
              className={styles.heroIllustration}
              onClick={tapIllustration}
              onContextMenu={(event) => event.preventDefault()}
            >
              <span className={styles.heroStage}>
                <ThemedImage
                  sources={{ light: `${assetBase}hero-bg.svg`, dark: `${assetBase}hero-bg-dark.svg` }}
                  alt=""
                  width="520"
                  height="520"
                  draggable={false}
                />
                <HeroJar assetBase={assetBase} className={styles.heroJar} />
              </span>
            </button>
          </header>

          <section aria-label="Features" className={styles.pillars}>
            {pillars.map((pillar) => (
              <article key={pillar.title} className={styles.pillar}>
                <div className={styles.pillarText}>
                  <Heading as="h2">{pillar.title}</Heading>
                  <p>{pillar.body}</p>
                  <DocLink to={pillar.doc} label={pillar.docLabel}>
                    View doc
                  </DocLink>
                </div>
                <div
                  className={styles.pillarArt}
                  style={{ aspectRatio: `${pillar.width} / ${pillar.height}`, maxWidth: pillar.width }}
                  data-reveal=""
                >
                  <ThemedImage
                    sources={{ light: `${assetBase}${pillar.art}.svg`, dark: `${assetBase}${pillar.art}-dark.svg` }}
                    alt=""
                    width={pillar.width}
                    height={pillar.height}
                    loading="lazy"
                  />
                </div>
              </article>
            ))}
          </section>

          <section className={styles.frameworks} aria-label="Supported frameworks">
            <span>Works with</span>
            <ul>
              {frameworks.map((framework) => (
                <li key={framework.name} title={framework.detail}>
                  <span
                    className={styles.frameworkLogo}
                    aria-hidden="true"
                    style={
                      {
                        width: framework.width,
                        '--logo': `url(${frameworkBase}${framework.logo}.svg)`,
                      } as CSSProperties
                    }
                  />
                  <span className={styles.frameworkName}>{framework.name}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.desktop} aria-labelledby="desktop-heading">
            <div className={styles.sectionIntro}>
              <Heading as="h2" id="desktop-heading">
                See what every agent sees
              </Heading>
              <p>
                Every workspace, device, build and log in one Mac app. Take control of a device, or share a link to it.
              </p>
              <div className={styles.inlineLinks}>
                <DocLink to="/docs/desktop">Stim Desktop</DocLink>
                <DocLink to="/docs/share">Share a running app</DocLink>
              </div>
            </div>
            <figure className={styles.screenshot} data-reveal="">
              <img
                src={`${desktopBase}workspace.webp`}
                alt="Stim Desktop showing a project with five worktrees and two live iPhone simulators running a music player and a fitness app"
                width="1600"
                height="959"
                loading="lazy"
              />
            </figure>
            <div className={styles.screenshotPair}>
              <figure data-reveal="">
                <img
                  src={`${desktopBase}logs.webp`}
                  alt="Stim Desktop log panel with a Metro syntax error and its file and line, below simulators running a weather app and a photo gallery"
                  width="1600"
                  height="959"
                  loading="lazy"
                />
                <figcaption>Metro, app, native and agent logs in one place.</figcaption>
              </figure>
              <figure data-reveal="">
                <img
                  src={`${desktopBase}machine.webp`}
                  alt="Stim Desktop machine view with memory, CPU, disk, top resource users and storage to reclaim"
                  width="1600"
                  height="959"
                  loading="lazy"
                />
                <figcaption>CPU, memory and disk for the whole Mac, and what is safe to free.</figcaption>
              </figure>
            </div>
          </section>

          <section className={styles.forAgents} aria-labelledby="agents-heading">
            <div className={styles.sectionIntro}>
              <Heading as="h2" id="agents-heading">
                Made for agents
              </Heading>
              <p>Short output and errors that name the next step. The whole loop is a handful of commands.</p>
              <DocLink to="/docs/commands">Command reference</DocLink>
            </div>
            <div className={styles.terminal}>
              <CodeBlock language="text">{launchOutput}</CodeBlock>
            </div>
          </section>

          <div className={styles.closing}>
            <div className={styles.closingText}>
              <section className={styles.why} aria-labelledby="why-stim">
                <Heading as="h2" id="why-stim">
                  Why Stim
                </Heading>
                <p>
                  Stim started as a way to stop two agents from fighting over one simulator. It grew into the place
                  where agents build and run your app.
                </p>
                <DocLink to="/docs/why">More about Stim</DocLink>
              </section>

              <section className={styles.agentSetup} aria-labelledby="agent-setup">
                <Heading as="h2" id="agent-setup">
                  Give your agent the skill
                </Heading>
                <CodeBlock language="bash">npx skills add appandflow/stim</CodeBlock>
                <p>Then ask your agent: &quot;Build and run the app on iOS.&quot; No setup in your project.</p>
                <DocLink to="/docs/agent-skills">Agent setup</DocLink>
              </section>
            </div>
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
      </div>
    </Layout>
  );
}
