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

private func ago(_ now: Date, _ text: String?) -> String? {
  guard let text, let at = parseTimestamp(text) else { return nil }
  return Format.duration(now.timeIntervalSince(at))
}

extension Workspace {
  /// Changes whenever a run of either platform finishes, so a view of `stim stats` knows to read it again.
  public var finishedRunsStamp: String {
    [lastBuilds?.ios, lastBuilds?.android].map { $0?.finishedAt ?? "" }.joined(separator: "|")
  }

  var latestBuild: LastBuild? {
    [lastBuilds?.ios, lastBuilds?.android].compactMap { $0 }.max {
      (parseTimestamp($0.startedAt) ?? .distantPast) < (parseTimestamp($1.startedAt) ?? .distantPast)
    }
  }

  /// The app presence `stim` reports on the device, or for an older `stim` the same rule run here.
  public func appPresence(_ device: DeviceRef) -> AppPresence? {
    guard stageFacts != nil else { return localAppPresence(device) }
    let reported: String?
    switch device {
    case .ios(_, let d): reported = d.physical ? nil : d.appPresence
    case .android(_, let d): reported = d.physical ? nil : d.appPresence
    case .web, .remote: reported = nil
    }
    switch reported {
    case "none": return AppPresence.none
    case "closed": return .closed
    default: return nil
    }
  }

  /// Status reports `app` whenever it knows the bundle id, and a process that is not running cannot tell a closed
  /// app from one never installed, so a device has no app only when its platform never built successfully here and
  /// the latest build failed.
  func localAppPresence(_ device: DeviceRef) -> AppPresence? {
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

  /// The order `orderedDevices` gives running simulators and emulators: iOS before Android, then by slot.
  static func deviceOrder(_ a: StageFacts.ClosedApp, _ b: StageFacts.ClosedApp) -> Bool {
    if a.platform != b.platform { return a.platform == "ios" }
    return a.slot.localizedCompare(b.slot) == .orderedAscending
  }

  static let stageKinds: Set = ["building", "warming", "ready", "build-failed", "running", "stopped"]

  /// The stage `stim` decided, for an older `stim` the same rule run here.
  func localStageFacts() -> StageFacts {
    func facts(_ kind: String, _ since: String?, _ platform: String? = nil) -> StageFacts {
      StageFacts(kind: kind, since: since, platform: platform, closedApps: [])
    }
    if let build, build.isRunning { return facts("building", build.startedAt, build.platform) }
    if !live, phase == "warming" { return facts("warming", phaseSince) }
    if !live, phase == "ready" { return facts("ready", phaseSince) }
    if let latest = latestBuild, latest.status == "failed" {
      return facts("build-failed", latest.finishedAt ?? latest.startedAt, latest.platform)
    }
    if live || remoteDevices?.isEmpty == false {
      var running = facts("running", supervisor?.startedAt)
      running.closedApps = orderedDevices.filter { localAppPresence($0) == .closed }.map {
        StageFacts.ClosedApp(platform: $0.platform, slot: $0.slot)
      }
      return running
    }
    return facts("stopped", metro?.lastStop?.at)
  }

  public func stage(now: Date) -> WorkspaceStage {
    let reported = stageFacts.flatMap { Self.stageKinds.contains($0.kind) ? $0 : nil }
    let facts = reported ?? localStageFacts()
    let platform = facts.platform.map(platformName) ?? ""
    switch facts.kind {
    case "building":
      let since = ago(now, facts.since).map { " \u{00B7} started \($0) ago" } ?? ""
      return WorkspaceStage(label: .building, tone: .brand, subtitle: platform + since)
    case "warming":
      let step = warmStep == "copy" ? "copying ignored files" : "installing dependencies"
      return WorkspaceStage(
        label: .warming, tone: .warning, subtitle: ago(now, facts.since).map { "\(step) \u{00B7} \($0)" } ?? step)
    case "ready":
      return WorkspaceStage(label: .ready, tone: .success, subtitle: ago(now, facts.since).map { "warmed \($0) ago" })
    case "build-failed":
      let since = ago(now, facts.since).map { " \u{00B7} \($0) ago" } ?? ""
      return WorkspaceStage(label: .buildFailed, tone: .error, subtitle: platform + since)
    case "running":
      let errors = logs?.errorsSinceMarker ?? 0
      let problems =
        (errors > 0 ? [countLabel(errors, "error")] : [])
        + facts.closedApps.sorted(by: Self.deviceOrder).map { "\(platformName($0.platform)) app closed" }
      let parts = (ago(now, facts.since).map { ["up \($0)"] } ?? []) + problems
      return WorkspaceStage(
        label: .running, tone: problems.isEmpty ? .success : .error,
        subtitle: parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} "))
    default:
      return WorkspaceStage(label: .stopped, tone: .tertiary, subtitle: ago(now, facts.since).map { "\($0) ago" })
    }
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

  /// Sampled figures fill only what `stim status` left empty. Memory comes from a sample only when it is a footprint;
  /// summed resident size counts shared pages once per process and can exceed the Mac's RAM.
  public func filling(cpuPercent sampledCpu: Double?, footprintMb: Double?) -> WorkspaceUsage {
    var usage = self
    if usage.cpuPercent == nil { usage.cpuPercent = sampledCpu }
    if usage.memoryMb == nil, let footprintMb, footprintMb > 0 { usage.memoryMb = footprintMb }
    return usage
  }
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

  /// The disk the workspace holds, split into parts that add up to `diskBytes`: node_modules, the rest of the
  /// worktree, and Stim's build folder. node_modules is part of the worktree, so it is split out of it.
  public var diskBreakdown: DiskBreakdown? {
    guard let disk else { return nil }
    var parts: [DiskBreakdown.Part] = []
    if let worktree = disk.worktreeBytes {
      if let modules = disk.nodeModulesBytes, modules > 0, modules <= worktree {
        parts.append(.init(kind: .nodeModules, bytes: modules))
        if worktree > modules { parts.append(.init(kind: .worktree, bytes: worktree - modules)) }
      } else {
        parts.append(.init(kind: .worktree, bytes: worktree))
      }
    }
    if let build = disk.buildBytes, build > 0 { parts.append(.init(kind: .build, bytes: build)) }
    return parts.isEmpty ? nil : DiskBreakdown(parts: parts)
  }
}

public struct DiskBreakdown: Equatable, Sendable {
  public struct Part: Equatable, Identifiable, Sendable {
    public enum Kind: String, Sendable { case nodeModules, worktree, build }
    public var kind: Kind
    public var bytes: Double
    public var id: Kind { kind }

    public func label(splitFromNodeModules: Bool) -> String {
      switch kind {
      case .nodeModules: "node_modules"
      case .worktree: splitFromNodeModules ? "Rest of worktree" : "Worktree"
      case .build: "Build output"
      }
    }
  }

  public var parts: [Part]
  public var total: Double { parts.reduce(0) { $0 + $1.bytes } }
  public var hasNodeModules: Bool { parts.contains { $0.kind == .nodeModules } }
  public func label(of part: Part) -> String { part.label(splitFromNodeModules: hasNodeModules) }
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

public struct BundleLine: Equatable, Sendable {
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
    let when = parseTimestamp(last.finishedAt).map { " \u{00B7} \(Format.since(now.timeIntervalSince($0))) ago" } ?? ""
    if last.status == "failed" { return BundleLine(text: "Bundle failed\(when)", tone: .error) }
    return BundleLine(text: "Bundled in \(Format.tenths(last.durationMs / 1000))s\(when)", tone: .tertiary)
  }

  public var metroHealth: MetroHealth? {
    guard let metro else { return nil }
    if !metro.running { return .stopped }
    return supervisor?.healthy == false ? .unhealthy : .healthy
  }
}

/// The git and pull request chip beside the stage: the pull request coloured by its state with one CI mark, and
/// git details only when there are some.
public struct GitChip: Equatable, Sendable {
  public enum Checks: String, Sendable {
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
    let facts = worktree.gitChip ?? Self.localFacts(git, pull)
    let parts = facts.parts.compactMap { part -> Part? in
      switch part.kind {
      case "arrows":
        return WorktreeGit.arrows(ahead: part.ahead ?? 0, behind: part.behind ?? 0).map { Part(text: $0, tone: .normal) }
      case "changed": return Part(text: "\(part.count ?? 0) changed", tone: .neutral)
      case "merged": return Part(text: "merged into \(part.into ?? "")", tone: .brand)
      case "no-upstream": return Part(text: "no upstream", tone: .tertiary)
      default: return nil
      }
    }
    self.parts = parts
    let checks: Checks? = pull == nil ? nil : facts.ci.flatMap { Checks(rawValue: $0) }
    pullRequest = pull.map {
      PullRequest(
        text: "PR #\($0.number)", tone: Self.tone(ofPullRequest: $0.state), checks: checks, url: URL(string: $0.url))
    }
    label = [
      pull.map { "Pull request \($0.number), \($0.state)" } ?? "Branch",
      checks.map { "checks \($0)" },
      git.isNotable ? git.summary : nil,
      facts.parts.contains { $0.kind == "no-upstream" } ? "no upstream" : nil,
      pull == nil && parts.isEmpty ? "up to date" : nil,
    ].compactMap { $0 }.joined(separator: ", ")
  }

  /// The chip `stim` reports, for an older `stim` the same rule run here.
  static func localFacts(_ git: WorktreeGit, _ pull: PullRequestFacts?) -> GitChipFacts {
    var parts: [GitChipFacts.Part] = []
    if (git.ahead ?? 0) > 0 || (git.behind ?? 0) > 0 {
      parts.append(.init(kind: "arrows", ahead: git.ahead ?? 0, behind: git.behind ?? 0))
    }
    if git.uncommitted > 0 { parts.append(.init(kind: "changed", count: git.uncommitted)) }
    if let merged = git.mergedInto {
      if pull?.state != "merged" { parts.append(.init(kind: "merged", into: merged)) }
    } else if git.upstream == nil {
      parts.append(.init(kind: "no-upstream"))
    }
    return GitChipFacts(parts: parts, ci: pull.flatMap { checks($0.checks) }?.rawValue)
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
    return parts.isEmpty ? "No checks" : parts.joined(separator: ", ")
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

  public static let order = ["prepare", "cache-lookup", "wait", "prebuild", "pods", "compile", "device", "install", "launch"]

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

  /// Each phase's expected duration: the CLI's plan when it sends one, else the workspace's latest comparable run,
  /// which is all an older stim offers.
  func plannedDurations(_ history: [BuildHistoryEntry]) -> [String: Double] {
    if let plannedPhases {
      return Dictionary(plannedPhases.map { ($0.phase, $0.expectedMs) }, uniquingKeysWith: { _, last in last })
    }
    return referenceRun(history)?.phases ?? [:]
  }

  /// The build tool's own counts, which only describe `compile`; an older stim also sends them in later phases.
  var compileDetail: BuildDetail? { phase == "compile" ? detail : nil }

  /// The planned phases plus the current one, each done, current or pending.
  public func phaseSteps(history: [BuildHistoryEntry], now: Date) -> [PhaseStep] {
    let reference = plannedDurations(history)
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
      let counted = compileDetail.flatMap { detail -> Double? in
        guard let done = detail.done, let total = detail.total, total > 0 else { return nil }
        return Double(done) / Double(total)
      }
      let timed = expected.flatMap { expected in inPhase.flatMap { expected > 0 ? $0 / expected : nil } }
      let fraction = counted == nil && timed == nil ? nil : min(0.95, max(counted ?? 0, timed ?? 0))
      return PhaseStep(phase: step, state: .current, elapsedMs: inPhase, expectedMs: expected, fraction: fraction)
    }
  }

  /// "Compiling" with "45 of 180 targets", from the build tool's step when it reported one.
  public var currentPhaseLabel: (phase: String, counts: String?) {
    let steps = [
      "configure": "Configuring", "compile": "Compiling", "link": "Linking", "resources": "Copying resources",
      "script": "Running scripts", "dex": "Dexing", "package": "Packaging", "sign": "Signing",
    ]
    let detail = compileDetail
    let name = detail?.step.flatMap { steps[$0] } ?? remote(at: Date()).map(\.phase) ?? PhaseStep.name(phase)
    guard let unit = detail?.unit, let done = detail?.done else { return (name, nil) }
    return (name, detail?.total.map { "\(done) of \($0) \(unit)" } ?? "\(done) \(unit)")
  }
}

/// Whether a phase bar or checklist names its phases: only with more than one, since the stage line names a lone phase.
public func namesPhases(_ steps: [PhaseStep]) -> Bool { steps.count > 1 }

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

/// Each bar segment's share of the bar: its expected duration, at least 18% of the total so a short phase stays visible.
public func segmentWeights(_ steps: [PhaseStep]) -> [Double] {
  let total = steps.reduce(0) { $0 + ($1.expectedMs ?? 0) }
  return steps.map { total > 0 ? max($0.expectedMs ?? 0, total * 0.18) : 1 }
}

/// How full each bar segment is drawn for the build `key` names. The bar as a whole never moves backwards, even when
/// the CLI revises its plan once the run knows its outcome: segments fill left to right up to the most the bar
/// showed, but the current segment stops short of full, and a pending one stays empty.
public func barFills(_ steps: [PhaseStep], key: String) -> [Double] {
  guard !steps.isEmpty else { return [] }
  let weights = segmentWeights(steps)
  let total = weights.reduce(0, +)
  let own = steps.map { $0.state == .current ? ($0.fraction ?? 0.1) : ($0.fraction ?? 0) }
  let reached = zip(own, weights).reduce(0) { $0 + $1.0 * $1.1 } / total
  let ceiling =
    steps.firstIndex { $0.state == .current }.map { current in
      (weights[..<current].reduce(0, +) + 0.95 * weights[current]) / total
    } ?? zip(steps, weights).filter { $0.0.state == .done }.reduce(0) { $0 + $1.1 } / total
  var left = min(steadyFraction("\(key)|bar", reached), max(reached, ceiling)) * total
  return weights.map { weight in
    let fill = min(1, max(0, left / weight))
    left -= fill * weight
    return fill
  }
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
