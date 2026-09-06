import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import { StimInstallTabs } from '@site/src/components/StimTabs';
import {
  CacheIllustration,
  CleanupIllustration,
  ParallelIllustration,
  PlatformsIllustration,
} from '@site/src/components/FeatureIllustrations';

const features: Array<{ title: string; body: ReactNode; illustration: ReactNode }> = [
  {
    title: 'Fast builds across worktrees',
    body: (
      <>
        Native artifacts, Xcode compilation data, Gradle output, and Metro transforms are shared safely. A new worktree
        can install a cached app when its native inputs match. Concurrent misses use one build.
      </>
    ),
    illustration: <CacheIllustration />,
  },
  {
    title: 'Parallel agents without collisions',
    body: (
      <>
        Each checkout gets its own Metro port and owned device. Agents can create isolated git worktrees and work in
        parallel. Small, streaming output and focused errors reduce waiting and token use.
      </>
    ),
    illustration: <ParallelIllustration />,
  },
  {
    title: 'React Native and Expo, here or remote',
    body: (
      <>
        Stim works with React Native Community CLI and Expo projects. It builds locally, then launches on an owned
        simulator or emulator, connected phone, or configured remote device. The agent gets the exact device and launch
        state.
      </>
    ),
    illustration: <PlatformsIllustration />,
  },
  {
    title: 'Owned resources and complete cleanup',
    body: (
      <>
        Stim tracks every port, process, build, device, and remote session it creates. <code>stop</code>,{' '}
        <code>worktree remove</code>, and <code>gc</code> reclaim resources without touching devices Stim does not own.
      </>
    ),
    illustration: <CleanupIllustration />,
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout description="Stim gives coding agents fast, isolated React Native and Expo environments with shared build caches and owned devices.">
      <header className="hero hero--dark stimHero">
        <div className="container">
          <Heading as="h1" className="hero__title">
            {siteConfig.title}
          </Heading>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <p className="stimHeroLead">
            Give each coding agent a fast, isolated React Native environment. Stim shares build caches across worktrees,
            reserves a port and device for each workspace, and cleans up when the work is done.
          </p>
          <div className="stimQuickStart">
            <StimInstallTabs />
            <p>Add the agent skill:</p>
            <CodeBlock language="bash">npx skills add appandflow/stim</CodeBlock>
            <p>Then ask your agent: &quot;Build and run the app on iOS.&quot;</p>
            <p>Stim needs no initialization. Runtime state stays outside the project.</p>
          </div>
          <div className="stimHeroActions">
            <Link className="button button--primary button--lg" to="/docs/getting-started">
              Get started
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/why">
              Why Stim
            </Link>
          </div>
        </div>
      </header>
      <main>
        <section className="container stimFeatures">
          <div className="stimFeatureGrid">
            {features.map((f) => (
              <article key={f.title} className="stimFeatureCard">
                {f.illustration}
                <Heading as="h3">{f.title}</Heading>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="container stimFit" aria-labelledby="when-you-dont-need-stim">
          <Heading as="h2" id="when-you-dont-need-stim">
            When you probably don't need Stim
          </Heading>
          <p>
            Stim helps with repeated setup, builds, and device management across worktrees. If those aren't slowing you
            down, it may add little.
          </p>
          <ul>
            <li>
              <strong>One long-lived checkout, one running app.</strong> Your existing tooling already keeps builds
              warm. If you aren't juggling worktrees or agents, there's less to isolate and less duplicated work to
              avoid.
            </li>
            <li>
              <strong>An installed Expo development build and mostly JavaScript changes.</strong> You can keep using the
              same native app while Metro serves your changes. If native dependencies and configuration rarely change,
              there may be little build time to save.
            </li>
            <li>
              <strong>Agents that don't run the app.</strong> If your agents only edit code and run unit tests, they
              don't need isolated simulators or a native build workflow.
            </li>
            <li>
              <strong>Your existing setup already handles this.</strong> If your scripts or development platform provide
              isolated environments and reliable build reuse, Stim may duplicate what you have.
            </li>
            <li>
              <strong>You want cloud builds or app distribution.</strong> Stim builds locally; it doesn't replace hosted
              build infrastructure, signing workflows, or store submission.
            </li>
          </ul>
          <p>You don't need to replace a workflow that already works.</p>
        </section>
      </main>
    </Layout>
  );
}
