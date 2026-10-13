import type { ReactNode } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import data from '../data/benchmarks/native-luna-1.20.2.json';
import { formatSeconds } from './benchmarkData';
import styles from './NativeBenchmarkResults.module.css';

const names: Record<string, string> = { ios: 'Native iOS', android: 'Native Android', macos: 'Native macOS' };
const backends: Record<string, string> = {
  'native-xcode': 'SwiftUI / Xcode',
  'native-gradle': 'Kotlin / Gradle',
  'native-swiftpm': 'SwiftUI / SwiftPM',
};

export default function NativeBenchmarkResults(): ReactNode {
  const proofRoot = useBaseUrl('/benchmarks/native-luna-1.20.2/');
  return (
    <section className={styles.section} aria-labelledby="native-apps-title">
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Standalone native apps / Pilot results</span>
        <h2 id="native-apps-title">Beyond React Native</h2>
        <p>
          Change a native app's revision text, build and launch it, press Increment, and verify the new revision and
          count. Each result below is one accepted Stim/control pair on {data.machine}.
        </p>
        <p>
          <strong>Total task time</strong> runs from dispatch to the completed agent turn, including reasoning, retries,
          builds, and proof capture. It differs from the React Native Settings-ready metric above. These small pilots
          show workflow results, not a general compile-speed claim.
        </p>
      </div>
      <div className={styles.grid}>
        {data.pairs.map((pair) => {
          const maximum = Math.max(...pair.runs.map((run) => run.taskSeconds));
          return (
            <article className={styles.card} key={pair.platform}>
              <div className={styles.cardHeading}>
                <div>
                  <h3>{names[pair.platform] ?? pair.platform}</h3>
                  <span>{backends[pair.backend] ?? pair.backend}</span>
                </div>
                <strong>
                  {Math.abs(pair.timeReductionPercent).toFixed(0)}%{' '}
                  {pair.timeReductionPercent >= 0 ? 'sooner' : 'longer'}
                </strong>
              </div>
              <p className={styles.caption}>One pair / Total task time / Lower is better</p>
              {pair.runs.map((run) => (
                <div className={styles.row} key={run.arm}>
                  <span>{run.arm === 'stim' ? 'Stim' : 'Control'}</span>
                  <div className={styles.track} aria-hidden="true">
                    <div
                      className={run.arm === 'stim' ? styles.stim : styles.control}
                      style={{ width: `${(100 * run.taskSeconds) / maximum}%` }}
                    />
                  </div>
                  <strong>{formatSeconds(run.taskSeconds)}</strong>
                </div>
              ))}
              <p className={styles.caption}>
                {pair.model} / {pair.reasoningEffort} reasoning / Stim {pair.provenance.stimVersion}
              </p>
              <details>
                <summary>Proof and environment</summary>
                <p>
                  Recorded {pair.runs[0].recordedOn}. macOS {pair.provenance.macosVersion}, Xcode{' '}
                  {pair.provenance.xcodeVersion}, Node {pair.provenance.nodeVersion}, Codex{' '}
                  {pair.provenance.codexVersion}. Requested service tier: {pair.requestedServiceTier}; returned tier
                  unverified.
                </p>
                <p>
                  Both runs passed independent source, command, process-identity, and visual checks. Cleanup completed
                  before publication. Screenshots show the changed revision and Count: 1.
                </p>
                <div className={styles.proofs}>
                  {pair.runs.map((run) => (
                    <figure key={run.arm}>
                      <a href={`${proofRoot}${run.proof}`}>
                        <img
                          loading="lazy"
                          src={`${proofRoot}${run.proof}`}
                          alt={`${names[pair.platform]} ${run.arm}: verified revision and Count: 1`}
                        />
                      </a>
                      <figcaption>
                        {run.arm === 'stim' ? 'Stim' : 'Control'} / {run.taskSeconds.toFixed(3)} s
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </details>
            </article>
          );
        })}
      </div>
      <p className={styles.note}>
        Native Xcode builds can reuse Stim artifacts and compiler cache. Native Gradle and macOS SwiftPM do not use
        Stim's artifact cache; their potential benefit is in workspace preparation, launch, and verification.
        {!data.pairs.some((pair) => pair.platform === 'android') &&
          ' Native Android results will appear after an accepted paired comparison.'}
      </p>
      <a href="https://github.com/appandflow/stim/blob/main/scripts/agent-benchmark/NATIVE.md">
        Read the native benchmark protocol
      </a>
    </section>
  );
}
