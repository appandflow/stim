import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import {
  benchmarks,
  linkedBenchmarks,
  readinessIntegrationChecks,
  displayVariant,
} from '@site/src/components/benchmarkCatalog';
import BenchmarkVideo from '@site/src/components/BenchmarkVideo';
import { benchmarkModelLabel } from '@site/src/components/benchmarkSelection';
import {
  benchmarkDisplayTitle,
  benchmarkOverview,
  benchmarkSelectionSearch,
  formatCost,
  formatSeconds,
  formatTokens,
  totalTokens,
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

          <section className={styles.overview} aria-labelledby="readiness-integration-title">
            <Heading as="h2" id="readiness-integration-title">
              Latest: Android readiness-integration checks
            </Heading>
            <p>
              Recorded September 8, 2026 on a Mac mini (Apple M4, 16 GB), Android 36 arm64. These Stim-only
              startup-error runs add optional early pending and post-splash ready logs. Every published run hit the
              native artifact cache, reported the injected crash in the initial launch command, repaired the source, and
              captured Settings proof. Times include worktree warming, emulator creation, diagnosis, repair, and
              screenshot capture.
            </p>
            <p>
              This is an integration check, not a new matched comparison: controls were not rerun with this fixture. The
              comparison runs below are retained, with the same first-activity timing rule. Stim was built locally from
              merged source{' '}
              <a href="https://github.com/appandflow/stim/commit/a4832aa34d9573ea2898604f6f639c71ae5f9804">a4832aa</a>,
              with package and executable hashes validated; it was not a new npm release.{' '}
              <Link to="/docs/dev-server-and-logs#ask-your-agent-to-add-it">Add optional readiness logs</Link>.
            </p>
            <div className={styles.checkTable}>
              <table>
                <thead>
                  <tr>
                    <th>Model / audit</th>
                    <th>Diagnosis</th>
                    <th>Settings proof</th>
                    <th>Total tokens</th>
                    <th>Total cost</th>
                  </tr>
                </thead>
                <tbody>
                  {readinessIntegrationChecks.map((benchmark) => {
                    const run = benchmark.runs[0];
                    const href = `/benchmarks/details${benchmarkSelectionSearch({ stage: benchmark.stage, runId: run.id }, linkedBenchmarks)}`;
                    return (
                      <tr key={benchmark.stage}>
                        <td>
                          <Link to={href}>{benchmarkModelLabel(run.model)}</Link>
                        </td>
                        <td>
                          <Link to={href}>{formatSeconds(run.diagnosisSeconds ?? null)}</Link>
                        </td>
                        <td>
                          <Link to={href}>{formatSeconds(run.settingsReadySeconds)}</Link>
                        </td>
                        <td>{formatTokens(totalTokens(run.usage))}</td>
                        <td>{formatCost(run.estimatedTokenCostUsd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p>
              Opus had 1m 35s before Claude Code emitted its initialization event; its first recorded agent activity was
              at 1m 36s. That lead-in is excluded from the displayed clock, with original dispatch timing retained in
              the audit. Its initial Stim launch took 54s, similar to Sol and Luna (52-53s). Costs cover the full agent
              turn, including work after the Settings screenshot: OpenAI costs are API-equivalent estimates; Claude
              costs are CLI-reported. Each row is one validated run, not an average. Sonnet is a separately requested
              repeat; its setup recovery remains in the timeline and elapsed time.
            </p>
          </section>

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
                    comparison is one matched run per arm, not an average or a best-of selection.
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
                What these numbers measure
              </Heading>
              <p>
                Readiness comparisons use the same clean app fixture, requested model, machine, and fixed code change.
                The primary endpoint starts at the first recorded agent message or shell-command start and stops only
                after agent-device finds the expected text on Settings and saves a screenshot. Each current run also
                records onboarding and navigation from the exact run device.
              </p>
              <p>
                Both arms exclude time before that first activity, including runner startup and any unobserved initial
                reasoning. Every timeline and milestone uses the same shifted origin; original dispatch timings remain
                available in the audit. This is not prompt-to-result latency. Tokens and cost still cover the full turn.
                Existing recordings are unchanged.
              </p>
              <a href="https://github.com/appandflow/stim/blob/main/docs/agent-benchmark.md">Read the full protocol</a>
            </div>
            <dl>
              <div>
                <dt>Separate tasks</dt>
                <dd>JavaScript-only changes, native changes, and launch-error recovery run as separate passes.</dd>
              </div>
              <div>
                <dt>Two arms</dt>
                <dd>
                  Stim uses its pinned published build; control uses local Expo and native platform tooling. iOS reuses
                  a prepared parked simulator, while both Android arms create a fresh matched AVD.
                </dd>
              </div>
              <div>
                <dt>Proof, not process liveness</dt>
                <dd>The reported time is the validated Settings screenshot, not the earlier app-process marker.</dd>
              </div>
              <div>
                <dt>Prepared caches</dt>
                <dd>
                  Installed dependencies and cache preparation are outside the timer. Android runs start from clean
                  generated native state, with a seeded Stim APK and compiler cache and shared warmed Gradle caches.
                  Both Android arms create their worktree and device inside the timer.
                </dd>
              </div>
              <div>
                <dt>Launch-failure suite</dt>
                <dd>
                  Eight matched comparisons cover Luna, Sol, Sonnet and Opus on iOS and Android. Diagnosis time and
                  repaired Settings proof are reported separately from readiness results. Runs execute sequentially on a
                  Mac mini with Apple M4 and 16 GB memory; each audit includes its toolchain details.
                </dd>
              </div>
              <div>
                <dt>Audited attempts</dt>
                <dd>
                  Transcript rules, device identity, isolation, and proof are checked; invalid runs are excluded, not
                  retried simply for a better result. Android native Stim runs also require verified compiler-cache
                  reuse against a fixed threshold established before dispatch.
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
