import Foundation

/// Where a workspace is, as the stage line beside its git chip words it.
public struct WorkspaceStage: Equatable, Sendable {
  public enum Label: String, Sendable {
    case running = "Running"
    case building = "Building"
    case buildFailed = "Build failed"
    case warming = "Warming"
    case ready = "Ready"
    case stopped = "Stopped"
  }

  public enum Tone: Sendable {
    case success, brand, error, warning, tertiary
  }

  public var label: Label
  public var tone: Tone
  public var subtitle: String?

  public init(label: Label, tone: Tone, subtitle: String?) {
    self.label = label
    self.tone = tone
    self.subtitle = subtitle
  }
}

/// Whether a running device has the workspace's app: `none` when its platform never built successfully here and
/// the latest build failed, `closed` when status saw no app process.
public enum AppPresence: Sendable {
  case none, closed
}

/// "12m" for a duration, "<1m" under a minute.
public func shortDuration(_ seconds: TimeInterval) -> String {
  let minutes = Int(max(0, seconds) / 60)
  if minutes < 1 { return "<1m" }
  if minutes < 60 { return "\(minutes)m" }
  let hours = minutes / 60
  if hours < 24 { return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h\(String(format: "%02d", minutes % 60))m" }
  return "\(hours / 24)d"
}

/// "2:38" for a build time.
public func clockDuration(ms: Double) -> String {
  let seconds = max(0, Int(ms / 1000))
  return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
}

/// "12s" under a minute, else `shortDuration`.
public func sinceLabel(_ seconds: TimeInterval) -> String {
  let clamped = max(0, seconds)
  return clamped < 60 ? "\(Int(clamped))s" : shortDuration(clamped)
}

private func ago(_ now: Date, _ text: String?) -> String? {
  guard let text, let at = parseTimestamp(text) else { return nil }
  return shortDuration(now.timeIntervalSince(at))
}

extension Workspace {
  var latestBuild: LastBuild? {
    [lastBuilds?.ios, lastBuilds?.android].compactMap { $0 }.max {
      (parseTimestamp($0.startedAt) ?? .distantPast) < (parseTimestamp($1.startedAt) ?? .distantPast)
    }
  }

  /// Status reports `app` whenever it knows the bundle id, and a process that is not running cannot tell a closed
  /// app from one never installed, so a device has no app only when its platform never built successfully here and
  /// the latest build failed.
  public func appPresence(_ device: DeviceRef) -> AppPresence? {
    guard device.isRunning, !device.isPhysical, device.app?.state != "running" else { return nil }
    switch device {
    case .ios, .android: break
    case .web, .remote: return nil
    }
    let history = device.platform == "ios" ? builds?.ios : builds?.android
    let everBuilt = history.map { $0.contains { $0.result == "succeeded" } } ?? true
    if lastBuilds?.build(for: device.platform)?.status == "failed", !everBuilt { return AppPresence.none }
    return device.app?.state == "stopped" ? .closed : nil
  }

  public func stage(now: Date) -> WorkspaceStage {
    if let build, build.isRunning {
      let since = ago(now, build.startedAt).map { " \u{00B7} started \($0) ago" } ?? ""
      return WorkspaceStage(label: .building, tone: .brand, subtitle: platformName(build.platform) + since)
    }
    if !live, phase == "warming" {
      let step = warmStep == "copy" ? "copying ignored files" : "installing dependencies"
      return WorkspaceStage(
        label: .warming, tone: .warning, subtitle: ago(now, phaseSince).map { "\(step) \u{00B7} \($0)" } ?? step)
    }
    if !live, phase == "ready" {
      return WorkspaceStage(label: .ready, tone: .success, subtitle: ago(now, phaseSince).map { "warmed \($0) ago" })
    }
    if let latest = latestBuild, latest.status == "failed" {
      let since = ago(now, latest.finishedAt ?? latest.startedAt).map { " \u{00B7} \($0) ago" } ?? ""
      return WorkspaceStage(label: .buildFailed, tone: .error, subtitle: platformName(latest.platform) + since)
    }
    if live || remoteDevices?.isEmpty == false {
      let errors = logs?.errorsSinceMarker ?? 0
      let problems =
        (errors > 0 ? [countLabel(errors, "error")] : [])
        + orderedDevices.filter { appPresence($0) == .closed }.map { "\(platformName($0.platform)) app closed" }
      let parts = (ago(now, supervisor?.startedAt).map { ["up \($0)"] } ?? []) + problems
      return WorkspaceStage(
        label: .running, tone: problems.isEmpty ? .success : .error,
        subtitle: parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} "))
    }
    return WorkspaceStage(label: .stopped, tone: .tertiary, subtitle: ago(now, metro?.lastStop?.at).map { "\($0) ago" })
  }
}

/// CPU as `ps` reports it (100 is one core), memory in MB and disk in bytes; nil where nothing measured it.
public struct WorkspaceUsage: Equatable, Sendable {
  public var cpuPercent: Double?
  public var memoryMb: Double?
  public var diskBytes: Double?

  public init(cpuPercent: Double? = nil, memoryMb: Double? = nil, diskBytes: Double? = nil) {
    self.cpuPercent = cpuPercent
    self.memoryMb = memoryMb
    self.diskBytes = diskBytes
  }

  public var isEmpty: Bool { cpuPercent == nil && memoryMb == nil && diskBytes == nil }
}

extension MachineUsage {
  public func owners(of workspace: String) -> [MachineOwner] { owners.filter { $0.workspace == workspace } }
}

extension DeviceRef {
  /// The simulator's data folder or the emulator's AVD folder, once a status watcher has measured it.
  public var diskBytes: Double? {
    switch self {
    case .ios(_, let d): return d.disk?.bytes
    case .android(_, let d): return d.disk?.bytes
    case .remote, .web: return nil
    }
  }
}

extension Workspace {
  public var diskBytes: Double? {
    guard let disk, disk.worktreeBytes != nil || disk.buildBytes != nil else { return nil }
    return (disk.worktreeBytes ?? 0) + (disk.buildBytes ?? 0)
  }

  /// The workspace's machine owners summed, else its status memory.
  public func usage(machine: MachineUsage?) -> WorkspaceUsage {
    let owners = machine?.owners(of: path) ?? []
    let memory: Double?
    if !owners.isEmpty {
      memory = Double(owners.reduce(0) { $0 + $1.memory })
    } else if let memoryMb, memoryMb > 0 {
      memory = Double(memoryMb)
    } else {
      memory = nil
    }
    return WorkspaceUsage(
      cpuPercent: owners.isEmpty ? nil : owners.reduce(0) { $0 + $1.cpuPercent }, memoryMb: memory,
      diskBytes: diskBytes)
  }

  /// The owner that holds a device's processes. An emulator owner's id is its AVD name, not the serial, so devices
  /// match on workspace, slot and kind. A physical device runs no process on the Mac.
  public func owner(of device: DeviceRef, machine: MachineUsage?) -> MachineOwner? {
    guard !device.isPhysical else { return nil }
    let kind: MachineOwner.Kind
    switch device {
    case .ios: kind = .simulator
    case .android: kind = .emulator
    case .web: kind = .browser
    case .remote: return nil
    }
    return machine?.owners(of: path).first { $0.kind == kind && ($0.slot ?? DeviceRef.defaultSlot) == device.slot }
  }

  public func usage(of device: DeviceRef, machine: MachineUsage?) -> WorkspaceUsage? {
    let owner = owner(of: device, machine: machine)
    guard owner != nil || device.diskBytes != nil else { return nil }
    return WorkspaceUsage(
      cpuPercent: owner?.cpuPercent, memoryMb: owner.map { Double($0.memory) }, diskBytes: device.diskBytes)
  }

  /// "Disk: worktree 1.9 GB, node_modules 0.9 GB of it, build output 0.3 GB."
  public func diskBreakdown(format: (Double) -> String) -> String? {
    guard let disk else { return nil }
    let parts = [
      disk.worktreeBytes.map { "worktree \(format($0))" },
      disk.nodeModulesBytes.map { "node_modules \(format($0)) of it" },
      disk.buildBytes.map { "build output \(format($0))" },
    ].compactMap { $0 }
    return parts.isEmpty ? nil : "Disk: \(parts.joined(separator: ", "))."
  }
}

public struct ProcessRow: Equatable, Identifiable, Sendable {
  public var id: String
  public var label: String
  public var cpuPercent: Double
  public var memoryMb: Double
}

extension Workspace {
  /// The workspace's machine owners, devices first, then Chrome, Metro and builds.
  public func processRows(machine: MachineUsage?) -> [ProcessRow] {
    let order: [MachineOwner.Kind] = [.simulator, .emulator, .browser, .metro, .build]
    return (machine?.owners(of: path) ?? []).enumerated().sorted { a, b in
      let (ra, rb) = (order.firstIndex(of: a.element.kind) ?? 99, order.firstIndex(of: b.element.kind) ?? 99)
      return ra != rb ? ra < rb : a.offset < b.offset
    }.map { _, owner in
      ProcessRow(id: owner.key, label: label(of: owner), cpuPercent: owner.cpuPercent, memoryMb: Double(owner.memory))
    }
  }

  private func label(of owner: MachineOwner) -> String {
    let slot = owner.slot.flatMap { $0 == DeviceRef.defaultSlot ? nil : " \u{00B7} \($0)" } ?? ""
    switch owner.kind {
    case .simulator:
      let device = devices.first { $0.platform == "ios" && $0.slot == (owner.slot ?? DeviceRef.defaultSlot) }
      return "\(device?.modelName ?? "iOS") simulator\(slot)"
    case .emulator: return "Android emulator\(slot)"
    case .browser: return "Chrome (web)"
    case .metro: return "Metro"
    case .build:
      return (owner.id == "ios" || owner.id == "android" ? "\(platformName(owner.id!)) build" : "Build") + slot
    default: return owner.name
    }
  }
}

/// One platform's row in the Build card: a finished run, a failure, or the next build's estimate.
public struct BuildLine: Equatable, Sendable {
  public enum Tone: Sendable {
    case normal, error, secondary
  }

  public var platform: String
  public var main: String
  public var sub: String?
  public var tone: Tone
  /// A prediction from `stim <platform> --plan`, not a finished run.
  public var isEstimate: Bool

  public init(platform: String, main: String, sub: String?, tone: Tone, isEstimate: Bool = false, spoken: String) {
    self.platform = platform
    self.main = main
    self.sub = sub
    self.tone = tone
    self.isEstimate = isEstimate
    self.spoken = "\(platformName(platform)) \(spoken)"
  }

  /// "iOS 0:33 hit", "Android next ~0:40 hit" for accessibility and help.
  /// "iOS last build 0:33, hit" or "Android next build about 0:40, hit", for accessibility and help.
  public var spoken: String

  public static func make(platform: String, last: LastBuild?, plan: BuildPlanChecks.State?) -> BuildLine {
    if let last {
      if last.status == "failed" {
        return BuildLine(platform: platform, main: "Failed", sub: nil, tone: .error, spoken: "last build failed")
      }
      let cache = last.cacheHit == .none ? "cold" : "hit"
      guard let duration = last.durationMs else {
        return BuildLine(platform: platform, main: "\u{2014}", sub: cache, tone: .normal, spoken: "last build \(cache)")
      }
      let took = clockDuration(ms: duration)
      return BuildLine(platform: platform, main: took, sub: cache, tone: .normal, spoken: "last build \(took), \(cache)")
    }
    switch plan {
    case .done(.plan(let plan)) where plan.refusal == nil:
      let cache = plan.cacheHit == .none ? "cold" : "hit"
      guard let expected = plan.expectedMs else {
        return BuildLine(
          platform: platform, main: "\u{2014}", sub: "est. \(cache)", tone: .secondary, isEstimate: true,
          spoken: "next build \(cache)")
      }
      let took = clockDuration(ms: expected)
      return BuildLine(
        platform: platform, main: "~\(took)", sub: "est.", tone: .secondary, isEstimate: true,
        spoken: "next build about \(took), \(cache)")
    case .checking:
      return BuildLine(
        platform: platform, main: "Checking\u{2026}", sub: nil, tone: .secondary, spoken: "checking the next build")
    default:
      return BuildLine(platform: platform, main: "No build", sub: nil, tone: .secondary, spoken: "no build")
    }
  }
}

extension Workspace {
  /// The platforms the Build card shows: those the workspace has built, run or recorded, else both.
  public var buildCardPlatforms: [String] {
    let running = build.flatMap { $0.isRunning ? $0.platform : nil }
    let used = ["ios", "android"].filter { platform in
      running == platform || usedPlatforms.contains(platform)
        || remoteDevices?.contains { $0.platform == platform } == true
    }
    return used.isEmpty ? ["ios", "android"] : used
  }

  /// "Android · last build 0:48, 2h ago" under the build-in-progress card, for the platform that is not building.
  public func otherPlatformLine(building: String, now: Date) -> String? {
    let other = building == "ios" ? "android" : "ios"
    guard usedPlatforms.contains(other) else { return nil }
    let name = platformName(other)
    guard let last = lastBuilds?.build(for: other) else { return "\(name) \u{00B7} no build recorded" }
    let since = ago(now, last.finishedAt ?? last.startedAt)
    if last.status == "failed" { return "\(name) \u{00B7} last build failed\(since.map { ", \($0) ago" } ?? "")" }
    let parts = [last.durationMs.map { clockDuration(ms: $0) }, since.map { "\($0) ago" }].compactMap { $0 }
    return "\(name) \u{00B7} last build \(parts.joined(separator: ", "))"
  }
}

public struct BundleLine: Equatable, Sendable {
  public enum Tone: Sendable {
    case normal, error, tertiary
  }

  public var text: String
  public var tone: Tone
}

public enum MetroHealth: String, Sendable {
  case healthy, unhealthy, stopped
}

extension Workspace {
  /// `reportsBundles` is whether any workspace in the payload reports `metro.bundle`, so a `stim` that never does
  /// shows no line instead of "Not bundled yet".
  public func bundleLine(now: Date, reportsBundles: Bool) -> BundleLine? {
    guard let metro else { return nil }
    guard let bundle = metro.bundle else {
      return reportsBundles && metro.running ? BundleLine(text: "Not bundled yet", tone: .tertiary) : nil
    }
    if bundle.bundling {
      return BundleLine(text: "Bundling" + (bundle.percent.map { " \u{00B7} \(Int($0.rounded()))%" } ?? ""), tone: .normal)
    }
    guard let last = bundle.last else { return nil }
    let when = parseTimestamp(last.finishedAt).map { " \u{00B7} \(sinceLabel(now.timeIntervalSince($0))) ago" } ?? ""
    if last.status == "failed" { return BundleLine(text: "Bundle failed\(when)", tone: .error) }
    return BundleLine(text: "Bundled in \(String(format: "%.1f", last.durationMs / 1000))s\(when)", tone: .tertiary)
  }

  public var metroHealth: MetroHealth? {
    guard let metro else { return nil }
    if !metro.running { return .stopped }
    return supervisor?.healthy == false ? .unhealthy : .healthy
  }
}

/// The row under a device: the driving tool and its last action, or how long the device has been idle.
public struct AgentRow: Equatable, Sendable {
  public var tool: String?
  public var text: String

  public init(activity: DeviceActivity?, last: (date: Date, message: String)?, now: Date) {
    let lastText = last.map { "\($0.message) \u{00B7} \(sinceLabel(now.timeIntervalSince($0.date))) ago" }
    if activity?.state == "driven" {
      tool = activity?.driver?.tool ?? "Agent"
      text = lastText ?? "no action yet"
      return
    }
    tool = nil
    let idleSince = last?.date ?? activity?.lastActivityAt.flatMap(parseTimestamp)
    text = idleSince.map { "idle \(shortDuration(now.timeIntervalSince($0)))" } ?? "nothing yet"
  }
}

/// The git and pull request chip beside the stage: the pull request coloured by its state with one CI mark, and
/// git details only when there are some.
public struct GitChip: Equatable, Sendable {
  public enum Tone: Sendable {
    case normal, secondary, tertiary, success, warning, error, brand
  }

  public enum Checks: Sendable {
    case passing, failing, pending
  }

  public struct Part: Equatable, Sendable {
    public var text: String
    public var tone: Tone
  }

  public struct PullRequest: Equatable, Sendable {
    public var text: String
    public var tone: Tone
    public var checks: Checks?
    public var url: URL?
  }

  public var parts: [Part]
  public var pullRequest: PullRequest?
  /// Spelled out for help text and accessibility.
  public var label: String

  public init?(_ worktree: WorktreeInfo?) {
    guard let worktree, let git = worktree.git else { return nil }
    let pull = worktree.pullRequest
    var parts: [Part] = []
    if let arrows = git.arrows { parts.append(Part(text: arrows, tone: .normal)) }
    if git.uncommitted > 0 { parts.append(Part(text: "\(git.uncommitted) changed", tone: .secondary)) }
    if let merged = git.mergedInto {
      if pull?.state != "merged" { parts.append(Part(text: "merged into \(merged)", tone: .brand)) }
    } else if git.upstream == nil {
      parts.append(Part(text: "no upstream", tone: .tertiary))
    }
    self.parts = parts
    let checks = pull.flatMap { Self.checks($0.checks) }
    pullRequest = pull.map {
      PullRequest(
        text: "PR #\($0.number)", tone: Self.tone(ofPullRequest: $0.state), checks: checks, url: URL(string: $0.url))
    }
    label = [
      pull.map { "Pull request \($0.number), \($0.state)" } ?? "Branch",
      checks.map { "checks \($0)" },
      git.isNotable ? git.summary : nil,
      git.mergedInto == nil && git.upstream == nil ? "no upstream" : nil,
      pull == nil && parts.isEmpty ? "up to date" : nil,
    ].compactMap { $0 }.joined(separator: ", ")
  }

  public static func tone(ofPullRequest state: String) -> Tone {
    switch state {
    case "open": return .success
    case "merged": return .brand
    case "closed": return .error
    default: return .tertiary
    }
  }

  public static func checks(_ checks: PullRequestFacts.Checks?) -> Checks? {
    guard let checks else { return nil }
    if checks.failing > 0 { return .failing }
    if checks.pending > 0 { return .pending }
    return checks.passing > 0 ? .passing : nil
  }

  /// "1 failing, 2 pending, 12 passing", or nil without checks.
  public static func checksSummary(_ checks: PullRequestFacts.Checks?) -> String? {
    guard let checks else { return nil }
    let parts = [
      checks.failing > 0 ? "\(checks.failing) failing" : nil,
      checks.pending > 0 ? "\(checks.pending) pending" : nil,
      checks.passing > 0 ? "\(checks.passing) passing" : nil,
    ].compactMap { $0 }
    return parts.isEmpty ? "none" : parts.joined(separator: ", ")
  }
}

/// One build phase in the build-in-progress card and the Build popover's checklist.
public struct PhaseStep: Equatable, Sendable {
  public enum State: Sendable {
    case done, current, pending
  }

  public var phase: String
  public var state: State
  public var elapsedMs: Double?
  public var expectedMs: Double?
  public var fraction: Double?

  public static let order = ["prepare", "cache-lookup", "wait", "prebuild", "pods", "compile", "install", "launch"]

  public static func name(_ phase: String) -> String {
    switch phase {
    case "cache-lookup": return "Cache lookup"
    default: return phase.prefix(1).uppercased() + phase.dropFirst()
    }
  }
}

extension Build {
  /// The newest successful run of the same slot and cache outcome, whose phase times are the estimates.
  public func referenceRun(_ history: [BuildHistoryEntry]) -> BuildHistoryEntry? {
    history.first { entry in
      entry.result == "succeeded" && entry.slot == slot
        && (outcome == nil || (entry.build.cacheHit != .none) == (outcome == "hit"))
    }
  }

  /// The phases the reference run entered plus the current one, each done, current or pending.
  public func phaseSteps(history: [BuildHistoryEntry], now: Date) -> [PhaseStep] {
    let reference = referenceRun(history)?.phases ?? [:]
    let currentIndex = PhaseStep.order.firstIndex(of: phase) ?? -1
    let inPhase = parseTimestamp(phaseStartedAt).map { max(0, now.timeIntervalSince($0) * 1000) }
    return PhaseStep.order.enumerated().filter { $0.offset == currentIndex || reference[$0.element] != nil }.map {
      i, step in
      let expected = step == phase ? (expectedPhaseMs ?? reference[step]) : reference[step]
      if i < currentIndex {
        return PhaseStep(phase: step, state: .done, elapsedMs: nil, expectedMs: expected, fraction: 1)
      }
      if i > currentIndex {
        return PhaseStep(phase: step, state: .pending, elapsedMs: nil, expectedMs: expected, fraction: 0)
      }
      let fraction: Double?
      if let done = detail?.done, let total = detail?.total, total > 0 {
        fraction = min(1, Double(done) / Double(total))
      } else if let expected, expected > 0, let inPhase {
        fraction = min(0.95, inPhase / expected)
      } else {
        fraction = nil
      }
      return PhaseStep(phase: step, state: .current, elapsedMs: inPhase, expectedMs: expected, fraction: fraction)
    }
  }

  /// "Compiling" with "45 of 180 targets", from the build tool's step when it reported one.
  public var currentPhaseLabel: (phase: String, counts: String?) {
    let steps = [
      "configure": "Configuring", "compile": "Compiling", "link": "Linking", "resources": "Copying resources",
      "script": "Running scripts", "dex": "Dexing", "package": "Packaging", "sign": "Signing",
    ]
    let name = detail?.step.flatMap { steps[$0] } ?? PhaseStep.name(phase)
    guard let unit = detail?.unit, let done = detail?.done else { return (name, nil) }
    return (name, detail?.total.map { "\(done) of \($0) \(unit)" } ?? "\(done) \(unit)")
  }
}

/// The short prepare phases folded into one segment and launch into install, for the progress bar.
public func barSteps(_ steps: [PhaseStep]) -> [PhaseStep] {
  let group = ["cache-lookup": "prepare", "wait": "prepare", "launch": "install"]
  var groups: [PhaseStep] = []
  for step in steps {
    let phase = group[step.phase] ?? step.phase
    guard let last = groups.last, last.phase == phase else {
      var first = step
      first.phase = phase
      groups.append(first)
      continue
    }
    let expected = (last.expectedMs ?? 0) + (step.expectedMs ?? 0)
    let doneMs = (last.state == .done ? last.expectedMs ?? 0 : 0) + (step.state == .done ? step.expectedMs ?? 0 : 0)
    let currentMs =
      step.state == .current
      ? (step.fraction ?? 0) * (step.expectedMs ?? 0)
      : last.state == .current ? (last.fraction ?? 0) * (last.expectedMs ?? 0) : 0
    let state: PhaseStep.State = last.state == step.state ? step.state : .current
    let fraction: Double? =
      switch state {
      case .done: 1
      case .pending: 0
      case .current: expected > 0 ? min(0.95, (doneMs + currentMs) / expected) : (step.fraction ?? last.fraction)
      }
    groups[groups.count - 1] = PhaseStep(
      phase: phase, state: state, elapsedMs: nil, expectedMs: expected > 0 ? expected : nil, fraction: fraction)
  }
  return groups
}

/// The last ten minutes of CPU and memory per workspace, from status `machine` owners sampled at `append` time.
public struct OwnerHistory: Sendable {
  public static let window: TimeInterval = 10 * 60

  public struct Sample: Equatable, Sendable {
    public var at: Date
    public var cpuPercent: Double
    public var memoryMb: Double
  }

  public private(set) var samples: [String: [Sample]] = [:]

  public init() {}

  /// Appends each workspace's owner sums and drops samples older than `window`; a workspace with no owner now
  /// drops its history.
  public mutating func append(_ machine: MachineUsage?, at now: Date) {
    var sums: [String: Sample] = [:]
    for owner in machine?.owners ?? [] {
      guard let workspace = owner.workspace else { continue }
      var sum = sums[workspace] ?? Sample(at: now, cpuPercent: 0, memoryMb: 0)
      sum.cpuPercent += owner.cpuPercent
      sum.memoryMb += Double(owner.memory)
      sums[workspace] = sum
    }
    samples = sums.reduce(into: [:]) { out, entry in
      out[entry.key] = (samples[entry.key] ?? []).filter { now.timeIntervalSince($0.at) < Self.window } + [entry.value]
    }
  }

  public func cpu(_ workspace: String) -> [Double] { samples[workspace]?.map(\.cpuPercent) ?? [] }
  public func memoryMb(_ workspace: String) -> [Double] { samples[workspace]?.map(\.memoryMb) ?? [] }

  /// How far back the workspace's samples reach.
  public func span(_ workspace: String) -> TimeInterval? {
    guard let first = samples[workspace]?.first, let last = samples[workspace]?.last, last.at > first.at else {
      return nil
    }
    return last.at.timeIntervalSince(first.at)
  }
}
