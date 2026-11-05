import Foundation

public struct BuildRun: Identifiable, Equatable, Sendable {
  public enum Source: Equatable, Sendable {
    case running(Build)
    case history(BuildHistoryEntry)
    case last(LastBuild)
  }

  public var source: Source

  public var running: Build? {
    if case .running(let build) = source { return build }
    return nil
  }

  public var history: BuildHistoryEntry? {
    if case .history(let entry) = source { return entry }
    return nil
  }

  public var last: LastBuild? {
    switch source {
    case .running: return nil
    case .history(let entry): return entry.build
    case .last(let build): return build
    }
  }

  public var platform: String { running?.platform ?? last!.platform }
  public var slot: String { running?.slot ?? history?.slot ?? DeviceRef.defaultSlot }
  public var startedAt: String { running?.startedAt ?? last!.startedAt }
  public var startedDate: Date? { parseTimestamp(startedAt) }
  public var finishedAt: String? { last?.finishedAt }
  public var finishedDate: Date? { finishedAt.flatMap(parseTimestamp) }
  public var durationMs: Double? { last?.durationMs }
  public var configuration: String? { history?.configuration }
  public var missReason: BuildMissReason? { running?.missReason ?? last?.missReason }
  public var errorCode: String? { last?.errorCode }
  public var diagnostics: [BuildDiagnostic] { last?.diagnostics ?? [] }
  public var offloadedTo: String? { last?.offloadedTo }
  public var offloadFallback: String? { last?.offloadFallback }
  public var id: String { "\(platform)|\(slot)|\(startedAt)" }
  public var result: String { running != nil ? "running" : history?.result ?? (last?.status == "ok" ? "succeeded" : "failed") }

  public var outcome: String {
    if running != nil { return "Running" }
    if let history { return history.outcome }
    guard let last else { return "" }
    if last.status != "ok" { return "Failed" }
    switch last.cacheHit {
    case .local: return "Local cache"
    case .remote: return "Remote cache"
    case .none: return last.offloadedTo.map { "Built on \(machineName($0))" } ?? "Compiled"
    }
  }

  public var isMacos: Bool { platform == "macos" }

  /// The header line: how long the run took and, for a macOS build, where it ran. macOS has no cache to report.
  public var summary: String {
    guard isMacos, let last else { return self.last?.summary ?? outcome }
    let took = last.durationMs.map { " in \(Format.elapsed(ms: $0))" } ?? ""
    switch result {
    case "succeeded": return (last.offloadedTo.map { "Built on \(machineName($0))" } ?? "Built") + took
    case "failed": return "Failed" + (last.errorCode.map { " (\($0))" } ?? "") + took
    default: return outcome
    }
  }

  /// `Swift Package Debug` for a macOS build; the configuration name for iOS and Android.
  public var configurationLabel: String? {
    guard let configuration else { return nil }
    return isMacos ? "Swift Package \(configuration)" : configuration
  }

  public var pillLabel: String {
    if isMacos, result == "succeeded" { return "Succeeded" }
    guard result == "succeeded", let last else { return outcome }
    switch last.cacheHit {
    case .local: return "Cache hit (local)"
    case .remote: return "Cache hit (remote)"
    case .none: return last.cacheSkipped == true ? outcome : "Cache miss"
    }
  }

  public var tone: Tone {
    switch result {
    case "running": return .brand
    case "failed": return .error
    case "succeeded": return last?.cacheHit == CacheSource.none && !isMacos ? .warning : .success
    default: return .warning
    }
  }

  public static func runs(platform: String, running: Build?, history: [BuildHistoryEntry], last: LastBuild?) -> [Self] {
    let active = running.flatMap { $0.isRunning && $0.platform == platform ? Self(source: .running($0)) : nil }
    var runs = active.map { [$0] } ?? []
    if history.isEmpty {
      if let last, last.platform == platform {
        let run = Self(source: .last(last))
        if run.id != active?.id { runs.append(run) }
      }
    } else {
      runs += history.map { Self(source: .history($0)) }.filter { $0.id != active?.id }
    }
    return runs
  }
}

extension BuildHistoryEntry {
  public var finishedSteps: [PhaseStep] {
    PhaseStep.order.compactMap { phase in
      phases[phase].map {
        PhaseStep(
          phase: phase, state: .done, elapsedMs: $0, expectedMs: nil, fraction: 1,
          note: phase == "compile" ? compileSteps.map { "\($0) steps" } : nil)
      }
    }
  }

  /// The phase a failed macOS build stopped in: the last one it entered.
  public var failedPhase: String? {
    guard result == "failed", build.platform == "macos" else { return nil }
    return PhaseStep.order.last { phases[$0] != nil }
  }

  public var stoppedPhase: String? {
    guard result == "interrupted" else { return nil }
    return PhaseStep.order.last { phases[$0] == 0 } ?? PhaseStep.order.last { phases[$0] != nil }
  }
}
