import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import { benchmarks, displayVariant } from '@site/src/components/benchmarkCatalog';
import BenchmarkVideo from '@site/src/components/BenchmarkVideo';
import { benchmarkModelLabel } from '@site/src/components/benchmarkSelection';
import {
  benchmarkDisplayTitle,
  benchmarkOverview,
  formatSeconds,
  type BenchmarkData,
  type BenchmarkRun,
} from '@site/src/components/benchmarkData';
import styles from './benchmarks.module.css';

const readinessBenchmarks = benchmarks.filter((benchmark) => benchmark.suite !== 'launch-crash');
const launchCrashBenchmarks = benchmarks.filter((benchmark) => benchmark.suite === 'launch-crash');
const readinessPlatforms = (['ios', 'android'] as const)
  .map((platform) => ({
    platform,
    benchmarks: readinessBenchmarks.filter((benchmark) => (benchmark.platform ?? 'ios') === platform),
  }))
  .filter(({ benchmarks: platformBenchmarks }) => platformBenchmarks.length > 0);

function OverviewChart({
  variant,
  benchmarks: allBenchmarks,
  title,
}: {
  variant: BenchmarkRun['variant'];
  benchmarks: BenchmarkData[];
  title?: string;
}): ReactNode {
  const overview = benchmarkOverview(allBenchmarks, variant);
  return (
    <article className={styles.overviewChart}>
      <div className={styles.overviewChartHead}>
        <h3>{title ?? displayVariant(variant)}</h3>
        <span>Settings-ready time</span>
      </div>
      <div className={styles.overviewLegend} aria-hidden="true">
        <span className={styles.stimKey}>Stim</span>
        <span className={styles.controlKey}>Control</span>
      </div>
      {overview.rows.map((row) => {
        const label =
          variant === 'launch-crash'
            ? benchmarkModelLabel(
                allBenchmarks.find((candidate) => candidate.stage === row.stage)?.runs[0]?.model ?? row.title,
              )
            : benchmarkDisplayTitle(row.title);
        const href = row.arms.find((arm) => arm.href)?.href;
        return (
          <div className={styles.overviewModel} key={row.stage}>
            <strong>{href ? <Link to={href}>{label}</Link> : label}</strong>
            <div className={styles.overviewBars}>
              {row.arms.map((arm) => {
                if (!arm.run || !arm.href) {
                  return (
                    <span className={styles.missingBar} key={arm.arm}>
                      <span>{arm.label}</span>
                      <span>No valid run</span>
                    </span>
                  );
                }
                return (
                  <Link
                    className={styles.overviewBarLink}
                    key={arm.arm}
                    to={arm.href}
                    aria-label={`${benchmarkDisplayTitle(row.title)} ${displayVariant(variant)}, ${arm.arm}, ${formatSeconds(arm.run.settingsReadySeconds)}. Open run audit.`}
                  >
                    <span>{arm.label}</span>
                    <span className={styles.overviewTrack} aria-hidden="true">
                      <span
                        className={`${styles.overviewBar} ${arm.arm === 'control' ? styles.controlBar : ''}`}
                        style={{ width: `${arm.widthPercent}%` }}
                      />
                    </span>
                    <strong>{formatSeconds(arm.run.settingsReadySeconds)}</strong>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </article>
  );
}

export default function Benchmarks(): ReactNode {
  return (
    <Layout
      title="Agent benchmarks"
      description="Auditable Stim agent benchmark results with command timelines and Settings-screen proof."
    >
      <main className={styles.page}>
        <div className="container">
          <header className={styles.hero}>
            <div className={styles.eyebrow}>Agent benchmark</div>
            <Heading as="h1">Stim agent benchmarks</Heading>
            <p>
              Compare how coding agents launch the same React Native app with Stim and the local Expo/native toolchain.
              Platforms and JavaScript/native tasks are measured separately, and every published time links to its
              command-level audit and Settings-screen proof.
            </p>
          </header>

          {readinessPlatforms.map(({ platform, benchmarks: platformBenchmarks }) => (
            <section className={styles.overview} aria-labelledby={`${platform}-overview-title`} key={platform}>
              <div className={styles.sectionHeading}>
                <div>
                  <Heading as="h2" id={`${platform}-overview-title`}>
                    {platform === 'ios' ? 'iOS' : 'Android'} performance across models
                  </Heading>
                  <p>Each bar is one valid run; missing or invalid cells are labeled. Lower time is better.</p>
                </div>
              </div>
              <div className={styles.overviewGrid}>
                {(['javascript', 'native'] as const).map((variant) => (
                  <OverviewChart key={variant} variant={variant} benchmarks={platformBenchmarks} />
                ))}
              </div>
            </section>
          ))}

          {launchCrashBenchmarks.length ? (
            <section className={styles.overview} aria-labelledby="launch-crash-title">
              <div className={styles.sectionHeading}>
                <div>
                  <Heading as="h2" id="launch-crash-title">
                    Launch failure diagnosis
                  </Heading>
                  <p>
                    A deterministic root-render exception is committed before dispatch. The agent must launch first,
                    diagnose from captured errors, repair the source, and prove the unchanged Settings screen. Each
                    comparison shows the latest validated run per arm, not an average or a best-of selection. Stim runs
                    use the same optional app readiness logs as controls. The crash and recovery task are identical;
                    Stim can use those signals to report the failure during launch.
                  </p>
                </div>
              </div>
              <div className={styles.overviewGrid}>
                {(['ios', 'android'] as const).map((platform) => (
                  <OverviewChart
                    key={platform}
                    variant="launch-crash"
                    title={`${platform === 'ios' ? 'iOS' : 'Android'} launch recovery`}
                    benchmarks={launchCrashBenchmarks.filter((candidate) => candidate.platform === platform)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className={styles.methodology} aria-labelledby="methodology-title">
            <div>
              <span className={styles.eyebrow}>Methodology</span>
              <Heading as="h2" id="methodology-title">
                How the comparisons work
              </Heading>
              <p>
                We compare Stim with standard Expo and native build tools on the same app. The goal is to measure how
                long an agent takes to complete a task and check the result in a running app.
              </p>
              <a href="https://github.com/appandflow/stim/blob/main/docs/agent-benchmark.md">Read the full protocol</a>
            </div>
            <dl>
              <div>
                <dt>Same task, same agent</dt>
                <dd>
                  Each comparison uses the same app task, AI model, and model settings. The agent works with Stim in one
                  run and without it in the other. Both arms use the same fixture, including optional app readiness logs
                  for the launch-error task.
                </dd>
              </div>
              <div>
                <dt>Same hardware</dt>
                <dd>
                  Runs use the same Mac mini and run one at a time, so they do not compete for resources. The device
                  model and OS version are matched within each comparison.
                </dd>
              </div>
              <div>
                <dt>Both setups start prepared</dt>
                <dd>
                  Dependencies are installed and build caches are warmed before timing starts. Stim can reuse saved
                  builds and pooled iOS simulators or Android emulators. We are measuring reuse during development, not
                  first-time setup.
                </dd>
              </div>
              <div>
                <dt>Consistent timing</dt>
                <dd>
                  Each clock runs from the agent's first recorded action until it has checked the result and saved a
                  screenshot. The same start and finish rules apply with and without Stim.
                </dd>
              </div>
              <div>
                <dt>Different kinds of work</dt>
                <dd>
                  We test JavaScript changes, native changes, and fixing an app that fails to launch. Results stay
                  separate by task, model, and platform, so a quick JavaScript change is not compared with a native
                  rebuild.
                </dd>
              </div>
              <div>
                <dt>Results you can inspect</dt>
                <dd>
                  Each bar represents the latest checked run, not an average or the fastest of several attempts. New
                  validated runs replace the previous result in place. Open it to see the commands, logs, and
                  screenshots. Runs that fail the protocol checks are excluded; the full protocol explains those rules.
                </dd>
              </div>
            </dl>
          </section>

          <BenchmarkVideo />

          <section className={styles.detailCta} aria-labelledby="detail-cta-title">
            <div>
              <span className={styles.eyebrow}>Command-level evidence</span>
              <Heading as="h2" id="detail-cta-title">
                Inspect every benchmark run
              </Heading>
              <p>
                Compare environments, play each command timeline, inspect terminal output, and open proof images and
                simulator recordings.
              </p>
            </div>
            <Link className="button button--primary" to="/benchmarks/details">
              Explore detailed audits
            </Link>
          </section>
        </div>
      </main>
    </Layout>
  );
}
