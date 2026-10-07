import Foundation

public enum OffloadResult: Equatable, Sendable {
  case success
  case refused(CommandRefusal)
  case unproven

  public static func parse(_ data: Data, machine: String, exit: Int32, stderr: String = "") throws -> Self {
    if let refusal = try? JSONDecoder().decode(CommandRefusal.self, from: data) { return .refused(refusal) }
    guard let facts = try? JSONDecoder().decode([String: JSONValue].self, from: data) else {
      throw StimCLI.Failure.exited(exit, stderr: stderr)
    }
    guard exit == 0, facts["offloadedTo"]?.string == machine,
      facts["launched"] == .bool(true) || facts["launched"] == .string("bundling")
    else { return .unproven }
    return .success
  }

  public static func localPassed(_ data: Data, exit: Int32, stderr: String = "") throws -> Bool {
    guard let facts = try? JSONDecoder().decode([String: JSONValue].self, from: data) else {
      throw StimCLI.Failure.exited(exit, stderr: stderr)
    }
    guard exit == 0 else { return false }
    return facts["offloadedTo"]?.string == nil && (facts["launched"] == .bool(true) || facts["launched"] == .string("bundling"))
  }
}

public struct BuildTimings: Decodable, Equatable, Sendable {
  public enum Failure: LocalizedError {
    case missingRecord
    public var errorDescription: String? {
      "The offloaded build launched, but its phase timings were not found in the build logs."
    }
  }
  public var offerMs: Double
  public var syncMs: Double
  public var workerMs: Double
  public var fetchMs: Double
  public var totalMs: Double
  public init(offerMs: Double, syncMs: Double, workerMs: Double, fetchMs: Double, totalMs: Double) {
    self.offerMs = offerMs
    self.syncMs = syncMs
    self.workerMs = workerMs
    self.fetchMs = fetchMs
    self.totalMs = totalMs
  }
  public static func record(_ data: Data) throws -> Self {
    struct Record: Decodable {
      var event: String
      var timings: BuildTimings
    }
    let lines = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline)
    for line in lines.reversed() {
      if let record = try? JSONDecoder().decode(Record.self, from: Data(line.utf8)), record.event == "offload_done" {
        return record.timings
      }
    }
    throw Failure.missingRecord
  }
}

public struct BuildTest: Equatable, Sendable {
  public enum Outcome: Equatable, Sendable {
    case passed, skipped, notRun
    case skippedAfterFailure(String)
    case failed(String)

    public var symbol: String {
      switch self {
      case .passed: return "checkmark.circle.fill"
      case .failed: return "exclamationmark.triangle.fill"
      case .skipped, .skippedAfterFailure, .notRun: return "minus.circle.fill"
      }
    }

    public var accessibilityLabel: String {
      switch self {
      case .passed: return "Test build, done"
      case .skipped: return "Test build, skipped"
      case .skippedAfterFailure: return "Test build, skipped after a failed run"
      case .failed: return "Test build, failed"
      case .notRun: return "Test build, not run"
      }
    }

    public var summaryText: String? {
      switch self {
      case .passed: return nil
      case .skipped: return "Test build skipped."
      case .skippedAfterFailure: return "Test build skipped after a failed run."
      case .failed(let message): return "Test build failed: \(message)"
      case .notRun: return "Test build not run."
      }
    }
  }
  public enum State: Equatable, Sendable {
    case preparingSample, ready
    case offloading(String)
    case offloaded(BuildTimings)
    case localBuilding
    case done
    case failed(code: String, message: String, remedy: String?)
    case skipped
  }
  public enum Event: Sendable {
    case prepare, prepared, start
    case progress(String)
    case offload(OffloadResult)
    case timings(BuildTimings)
    case localStart
    case localFinished(passed: Bool, ms: Double)
    case fail(code: String, message: String, remedy: String?)
    case skip
  }
  public private(set) var state: State = .preparingSample {
    didSet {
      if case .failed(_, let message, _) = state { lastFailure = message }
    }
  }
  public private(set) var timings: BuildTimings?
  public private(set) var localMs: Double?
  private var lastFailure: String?
  private var offloadPassed = false
  public var passed: Bool { state == .done }
  public var outcome: Outcome {
    switch state {
    case .done: return .passed
    case .skipped: return lastFailure.map(Outcome.skippedAfterFailure) ?? .skipped
    case .failed(_, let message, _): return .failed(message)
    default: return .notRun
    }
  }
  public init() {}
  public mutating func apply(_ event: Event) {
    switch event {
    case .prepare:
      lastFailure = nil
      state = .preparingSample
      timings = nil
      localMs = nil
    case .prepared:
      if state == .preparingSample {
        lastFailure = nil
        state = .ready
      }
    case .start:
      guard state == .ready || state == .done || isFailed || state == .skipped else { return }
      lastFailure = nil
      timings = nil
      localMs = nil
      offloadPassed = false
      state = .offloading("Starting the sample")
    case .progress(let phase): if case .offloading = state { state = .offloading(phase) }
    case .offload(let result):
      guard case .offloading = state else { return }
      switch result {
      case .success: offloadPassed = true
      case .refused(let refusal): state = .failed(code: refusal.code, message: refusal.message, remedy: refusal.remedy)
      case .unproven:
        state = .failed(
          code: "TEST_OFFLOAD_UNPROVEN", message: "The sample did not launch from a build on the selected Mac.",
          remedy: "Check the build Mac and run again.")
      }
    case .timings(let times):
      guard case .offloading = state, offloadPassed else { return }
      timings = times
      state = .offloaded(times)
    case .localStart: if case .offloaded = state { state = .localBuilding }
    case .localFinished(let passed, let ms):
      guard state == .localBuilding else { return }
      localMs = ms
      state =
        passed
        ? .done
        : .failed(
          code: "TEST_LOCAL_UNPROVEN", message: "The sample did not launch from a local build.",
          remedy: "Check this Mac's tools and run again.")
    case .fail(let code, let message, let remedy):
      if state != .skipped { state = .failed(code: code, message: message, remedy: remedy) }
    case .skip: state = .skipped
    }
  }
  private var isFailed: Bool {
    if case .failed = state { return true }
    return false
  }
}

public func sampleDuration(_ ms: Double) -> String {
  let seconds = max(0, Int(ms / 1000))
  return String(format: "%d:%02d", seconds / 60, seconds % 60)
}

public func speedComparison(machine: String, offloadMs: Double, localMs: Double) -> String {
  let difference = localMs - offloadMs
  if abs(difference) < 1000 { return "Builds on \(machine) took the same time as building here for this sample." }
  return
    "Builds on \(machine) were \(sampleDuration(abs(difference))) \(difference > 0 ? "faster" : "slower") than building here for this sample."
}

public enum WizardMode: String, CaseIterable, Sendable {
  case auto, force, off
  public var title: String {
    switch self {
    case .auto: return "Auto"
    case .force: return "Always"
    case .off: return "Never"
    }
  }
  public static func defaultChoice(passed: Bool, changedMode: Bool, current: String?) -> Self {
    changedMode ? (passed ? .auto : .off) : Self(rawValue: current ?? "auto") ?? .auto
  }
}

public func summaryLines(addedEntries: [String: String], mode: WizardMode) -> [String] {
  ["offload.machines", "hosting.machines"].compactMap { key in
    addedEntries[key].map { "Added \($0) to \(key)" }
  } + ["offload.mode = \(mode.rawValue)"]
}
