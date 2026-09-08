export function timeBenchmarkFromFirstActivity(benchmark) {
  const runs = benchmark.runs.map((run) => {
    if (run.timingOrigin?.kind === 'first-recorded-activity') return run;
    if (run.timingOrigin) throw new Error(`Unknown timing origin for ${run.id}`);
    const candidates = [
      ...run.messages.map((message) => ({ seconds: message.atSeconds, kind: 'message', id: message.id })),
      ...run.commands.map((command) => ({ seconds: command.startSeconds, kind: 'command', id: command.id })),
    ].filter((event) => Number.isFinite(event.seconds) && event.seconds >= 0);
    const first = candidates.reduce(
      (earliest, event) => (!earliest || event.seconds < earliest.seconds ? event : earliest),
      null,
    );
    if (!first) throw new Error(`No recorded activity for ${run.id}`);
    const shift = (seconds) => {
      if (seconds == null) return seconds;
      if (!Number.isFinite(seconds) || seconds < first.seconds) throw new Error(`Invalid event time for ${run.id}`);
      return Number((seconds - first.seconds).toFixed(3));
    };
    return {
      ...run,
      timingOrigin: {
        kind: 'first-recorded-activity',
        dispatchOffsetSeconds: first.seconds,
        event: { kind: first.kind, id: first.id },
        dispatchSettingsReadySeconds: run.settingsReadySeconds,
        dispatchDiagnosisSeconds: run.diagnosisSeconds ?? null,
        dispatchTotalSeconds: run.totalSeconds,
      },
      settingsReadySeconds: shift(run.settingsReadySeconds),
      appAliveSeconds: shift(run.appAliveSeconds),
      ...(run.diagnosisSeconds !== undefined ? { diagnosisSeconds: shift(run.diagnosisSeconds) } : {}),
      totalSeconds: shift(run.totalSeconds),
      messages: run.messages.map((message) => ({ ...message, atSeconds: shift(message.atSeconds) })),
      commands: run.commands.map((command) => ({
        ...command,
        startSeconds: shift(command.startSeconds),
        endSeconds: shift(command.endSeconds),
      })),
      backgroundProcesses: run.backgroundProcesses.map((process) => ({
        ...process,
        startSeconds: shift(process.startSeconds),
        endSeconds: shift(process.endSeconds),
      })),
      markers: run.markers.map((marker) => ({ ...marker, atSeconds: shift(marker.atSeconds) })),
    };
  });
  return {
    ...benchmark,
    primaryMetric:
      benchmark.suite === 'launch-crash'
        ? 'First recorded agent activity to actionable diagnosis; repaired Settings screenshot reported separately'
        : 'First recorded agent activity to validated Settings screenshot',
    runs,
  };
}
