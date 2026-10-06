import Foundation

/// The notification rules for a human who oversees agents, ported from `packages/core/oversight.ts`.
/// `OversightTests` replays the runs `packages/server/__tests__/oversight.test.ts` records in
/// `Fixtures/oversight-vectors.json`, so the two fail until they agree.
public enum OversightCategory: String, Codable, CaseIterable, Hashable, Sendable {
  case started, stuck, looping, finished, machine, control
  /// Stim Desktop only: something only a person can fix, from the needs-attention rule.
  case attention
  /// Stim Desktop only: another Mac asks to build on this one.
  case buildRequest = "build-request"
}

/// The part of a `stim status --json` payload the rules read.
public struct OversightStatus: Decodable, Sendable {
  public var environments: [OversightEnvironment]
  public var unprovisionedWorktrees: [OversightUnprovisioned]?
}

public struct OversightUnprovisioned: Decodable, Sendable {
  public var path: String
  public var repository: String?
}

public struct OversightActivity: Decodable, Sendable {
  public struct Driver: Decodable, Sendable {
    public var tool: String
    public var since: String?
  }

  public var state: String
  public var driver: Driver?
  public var lastActivityAt: String?
  public var recent: [String: String]?
}

public struct OversightDevice: Decodable, Sendable {
  public var name: String?
  public var state: String?
  public var physical: Bool?
  public var host: HostedIos?
  public var activity: OversightActivity?
}

public struct OversightBuild: Decodable, Sendable {
  public struct Diagnostic: Decodable, Sendable {
    public var file: String?
    public var line: Int?
  }

  public var platform: String?
  public var status: String?
  public var result: String?
  public var startedAt: String?
  public var finishedAt: String?
  public var errorCode: String?
  public var diagnostics: [Diagnostic]?
}

public struct OversightEnvironment: Decodable, Sendable {
  public struct Slot: Decodable, Sendable {
    public var slot: String
    public var ios: OversightDevice?
    public var android: OversightDevice?
  }

  public struct Worktree: Decodable, Sendable {
    public struct Git: Decodable, Sendable {
      public var mergedInto: String?
    }

    public var path: String
    public var branch: String?
    public var repository: String?
    public var git: Git?
  }

  public struct RunningBuild: Decodable, Sendable {
    public var state: String
    public var startedAt: String?
  }

  public struct Builds: Decodable, Sendable {
    public var ios: OversightBuild?
    public var android: OversightBuild?
  }

  public struct History: Decodable, Sendable {
    public var ios: [OversightBuild]?
    public var android: [OversightBuild]?
  }

  public struct Logs: Decodable, Sendable {
    public var errorsSinceMarker: Int?
  }

  public struct Web: Decodable, Sendable {
    public var running: Bool
    public var activity: OversightActivity?
  }

  public var path: String
  public var live: Bool
  public var phase: String?
  public var ios: OversightDevice?
  public var android: OversightDevice?
  public var slots: [Slot]?
  public var worktree: Worktree?
  public var build: RunningBuild?
  public var lastBuilds: Builds?
  public var builds: History?
  public var logs: Logs?
  public var web: Web?
}

/// A workspace's pull request, from GitHub.
public struct OversightPullRequest: Decodable, Sendable {
  public var number: Int
  /// `open`, `merged` or `closed`.
  public var state: String
  public var draft: Bool
  public var url: String
}

public enum MemoryPressureLevel: String, Decodable, Sendable {
  case normal, warning, critical
}

public enum OversightLink: String, Decodable, Sendable {
  case open, offline, refused, unpaired
}

public struct OversightInput: Decodable, Sendable {
  public var machine: String
  /// Nil when the machine's status is not current, so its workspaces are left as they were.
  public var status: OversightStatus?
  public var volumes: [Volume]?
  public var memoryPressure: MemoryPressureLevel?
  /// The phone's connection to the machine; nil where it is not known, as on the machine itself.
  public var link: OversightLink?
  /// Each workspace's pull request by path, nil when it has none; a missing path was not looked up.
  public var pullRequests: [String: OversightPullRequest?]
  /// `grantedAt` of the device leases stim-server holds for phones, so a person controlling a device is no agent.
  public var ownLeases: [String]

  public struct Volume: Decodable, Sendable {
    public var freeBytes: Double

    public init(freeBytes: Double) { self.freeBytes = freeBytes }
  }

  public init(
    machine: String, status: OversightStatus?, volumes: [Volume]?, memoryPressure: MemoryPressureLevel?,
    link: OversightLink? = nil, pullRequests: [String: OversightPullRequest?] = [:], ownLeases: [String] = []
  ) {
    self.machine = machine
    self.status = status
    self.volumes = volumes
    self.memoryPressure = memoryPressure
    self.link = link
    self.pullRequests = pullRequests
    self.ownLeases = ownLeases
  }
}

public struct OversightPrefs: Decodable, Sendable {
  public var categories: [OversightCategory]
  public var stuckMinutes: Int
  /// Whether it is quiet hours now: nothing notifies, and what still holds afterwards notifies then.
  public var quiet: Bool

  public init(categories: [OversightCategory], stuckMinutes: Int, quiet: Bool) {
    self.categories = categories
    self.stuckMinutes = stuckMinutes
    self.quiet = quiet
  }
}

public enum OversightTarget: Codable, Hashable, Sendable {
  case machine
  case workspace(path: String)
  case device(path: String, platform: String, slot: String)
  case build(path: String, platform: String)
  case url(path: String, url: String)
  /// A pending `stim-server` build request, by the id `stim-server devices` lists it under.
  case buildRequest(id: String)

  private enum Keys: String, CodingKey { case kind, path, platform, slot, url, id }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(String.self, forKey: .kind) {
    case "machine": self = .machine
    case "workspace": self = .workspace(path: try c.decode(String.self, forKey: .path))
    case "device":
      self = .device(
        path: try c.decode(String.self, forKey: .path), platform: try c.decode(String.self, forKey: .platform),
        slot: try c.decode(String.self, forKey: .slot))
    case "build":
      self = .build(
        path: try c.decode(String.self, forKey: .path), platform: try c.decode(String.self, forKey: .platform))
    case "url":
      self = .url(path: try c.decode(String.self, forKey: .path), url: try c.decode(String.self, forKey: .url))
    case "build-request": self = .buildRequest(id: try c.decode(String.self, forKey: .id))
    case let kind:
      throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown target \(kind)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case .machine:
      try c.encode("machine", forKey: .kind)
    case .workspace(let path):
      try c.encode("workspace", forKey: .kind)
      try c.encode(path, forKey: .path)
    case .device(let path, let platform, let slot):
      try c.encode("device", forKey: .kind)
      try c.encode(path, forKey: .path)
      try c.encode(platform, forKey: .platform)
      try c.encode(slot, forKey: .slot)
    case .build(let path, let platform):
      try c.encode("build", forKey: .kind)
      try c.encode(path, forKey: .path)
      try c.encode(platform, forKey: .platform)
    case .url(let path, let url):
      try c.encode("url", forKey: .kind)
      try c.encode(path, forKey: .path)
      try c.encode(url, forKey: .url)
    case .buildRequest(let id):
      try c.encode("build-request", forKey: .kind)
      try c.encode(id, forKey: .id)
    }
  }

  /// The workspace the target is in; nil for the machine.
  public var path: String? {
    switch self {
    case .machine, .buildRequest: return nil
    case .workspace(let path), .device(let path, _, _), .build(let path, _), .url(let path, _): return path
    }
  }
}

public struct OversightNotification: Codable, Hashable, Sendable {
  /// Stable for the workspace or machine and category, so a later notification replaces the earlier one.
  public var id: String
  public var category: OversightCategory
  public var title: String
  public var body: String
  /// Delivered without sound or banner interruption.
  public var quiet: Bool
  /// Groups notifications in the notification list; nil leaves them ungrouped.
  public var thread: String?
  public var target: OversightTarget
  /// The `stim` command that fixes what it reports, run from the target's workspace; nil when none does.
  public var remedy: String?

  public init(
    id: String, category: OversightCategory, title: String, body: String, quiet: Bool, thread: String?,
    target: OversightTarget, remedy: String? = nil
  ) {
    self.id = id
    self.category = category
    self.title = title
    self.body = body
    self.quiet = quiet
    self.thread = thread
    self.target = target
    self.remedy = remedy
  }
}

/// What the rules remember between calls. Opaque to callers: pass back the one the last call returned.
public struct OversightState: Sendable {
  struct Loop: Sendable {
    var signature: String
    var notified: Bool
  }

  struct PullRequest: Sendable {
    var number: Int
    var ready: Bool
    var merged: Bool
  }

  enum PullRequestLookup: Sendable {
    case notLookedUp
    case none
    case some(PullRequest)

    var merged: Bool {
      if case .some(let pr) = self { return pr.merged }
      return false
    }
  }

  struct Workspace: Sendable {
    var seenAt: Double
    var warmed: Bool
    var drove: Bool
    var drivenAt: Double?
    var driveNotified: Bool
    var errors: Int
    var errorsAt: Double?
    var stuckAt: Double?
    var finished: Bool
    var loops: [String: Loop]
    var pr: PullRequestLookup
    var mergedInto: String?
    var mergeNotified: Bool
  }

  struct Held: Sendable {
    var since: Double
    var notified: Bool
  }

  var workspaces: [String: Workspace] = [:]
  var disk: Held?
  var memory: Held?
  var memoryKnown: Bool?
  var link: Held?
  var linkKind: OversightLink?
}

public struct OversightResult: Sendable {
  public var state: OversightState
  public var notifications: [OversightNotification]
  /// When a timed rule may become due while nothing else changes, in milliseconds since 1970.
  public var wakeAt: Double?
}

public enum Oversight {
  public static let defaultStuckMinutes = 15

  static let workEvidence = ["agent-action", "metro-bundle", "workspace-use"]
  static let lowDiskBytes = 20e9
  static let diskCriticalBytes = lowDiskBytes / 4
  static let diskRecoveredBytes = diskCriticalBytes + 1e9
  static let memorySettleMs = 60_000.0
  static let offlineSettleMs = 60_000.0
  static let finishSettleMs = 5 * 60_000.0
  static let loopCount = 3
  static let forgetMs = 2 * 60_000.0

  static let languages: [String: String] = [
    "swift": "Swift", "m": "Objective-C", "mm": "Objective-C++", "kt": "Kotlin", "java": "Java", "c": "C",
    "cc": "C++", "cpp": "C++", "h": "C", "hpp": "C++", "js": "JavaScript", "ts": "TypeScript", "tsx": "TypeScript",
    "gradle": "Gradle", "kts": "Gradle",
  ]

  static func basename(_ path: String) -> String {
    path.split(separator: "/", omittingEmptySubsequences: false).last(where: { !$0.isEmpty }).map(String.init)
      ?? path
  }

  static func time(_ text: String?) -> Double {
    guard let text, let date = parseTimestamp(text) else { return .nan }
    return (date.timeIntervalSince1970 * 1000).rounded()
  }

  private static func parts(_ path: String) -> [String] {
    path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  }

  static func worktreeRoot(_ path: String) -> String? {
    let parts = parts(path)
    var i = parts.count - 2
    while i > 0 {
      if parts[i] == ".worktrees" { return parts[0..<i].joined(separator: "/") }
      if parts[i] == "worktrees" && parts[i - 1] == ".claude" { return parts[0..<(i - 1)].joined(separator: "/") }
      i -= 1
    }
    return nil
  }

  static func markedCheckout(_ path: String) -> String? {
    let parts = parts(path)
    var i = parts.count - 2
    while i > 0 {
      if parts[i] == ".worktrees" || (parts[i] == "worktrees" && parts[i - 1] == ".claude") {
        return parts[0..<(i + 2)].joined(separator: "/")
      }
      i -= 1
    }
    return nil
  }

  /// The name home shows for a workspace: its branch, else its checkout's folder.
  public static func title(_ env: OversightEnvironment, status: OversightStatus) -> String {
    if let branch = env.worktree?.branch, !branch.isEmpty { return branch }
    if let checkout = env.worktree?.path ?? markedCheckout(env.path) { return basename(checkout) }
    var roots: [String] = []
    func add(_ root: String) { if !roots.contains(root) { roots.append(root) } }
    for other in status.environments { add(worktreeRoot(other.path) ?? other.worktree?.repository ?? other.path) }
    for worktree in status.unprovisionedWorktrees ?? [] {
      if let root = worktreeRoot(worktree.path) ?? worktree.repository, !root.isEmpty { add(root) }
    }
    let own = worktreeRoot(env.path) ?? env.worktree?.repository
    let containing = roots.filter { env.path == $0 || env.path.hasPrefix("\($0)/") }
      .reduce(nil as String?) { best, r in best == nil || r.count < best!.count ? r : best }
    return basename(own ?? containing ?? env.path)
  }

  struct SlotDevice {
    var platform: String
    var slot: String
    var model: String
    var running: Bool
    var activity: OversightActivity?
  }

  static func devices(_ env: OversightEnvironment) -> [SlotDevice] {
    var out: [SlotDevice] = []
    func add(_ slot: String, _ ios: OversightDevice?, _ android: OversightDevice?) {
      if let ios {
        out.append(
          SlotDevice(
            platform: "ios", slot: slot, model: Format.simulatorModel(ios.name),
            running: ios.host != nil ? ios.state == "ready" : ios.state == "Booted",
            activity: ios.activity))
      }
      if let android {
        out.append(
          SlotDevice(
            platform: "android", slot: slot, model: android.physical == true ? "Android device" : "Android Emulator",
            running: android.state == "detected", activity: android.activity))
      }
    }
    add("default", env.ios, env.android)
    for slot in env.slots ?? [] { add(slot.slot, slot.ios, slot.android) }
    if let web = env.web {
      out.append(
        SlotDevice(platform: "web", slot: "default", model: "Chrome", running: web.running, activity: web.activity))
    }
    return out
  }

  static func agentDriven(_ device: SlotDevice, ownLeases: [String]) -> Bool {
    guard let activity = device.activity, activity.state == "driven" else { return false }
    let since = activity.driver?.since
    return !(activity.driver?.tool == "stim device lock" && since.map { !$0.isEmpty && ownLeases.contains($0) } == true)
  }

  static func newestBuild(_ env: OversightEnvironment) -> OversightBuild? {
    [env.lastBuilds?.ios, env.lastBuilds?.android].compactMap { $0 }.reduce(nil as OversightBuild?) { a, b in
      a == nil || time(b.startedAt) > time(a!.startedAt) ? b : a
    }
  }

  static func lastActivityAt(_ env: OversightEnvironment, _ devices: [SlotDevice], _ seen: [Double?]) -> Double? {
    var times = seen.map { $0 ?? .nan }
    for device in devices {
      if let recent = device.activity?.recent {
        times += workEvidence.map { time(recent[$0]) }
        if device.platform == "web" && device.activity?.state == "driven" { times.append(time(recent["page-log"])) }
      } else {
        times.append(time(device.activity?.lastActivityAt))
      }
      times.append(time(device.activity?.driver?.since))
    }
    for build in [env.lastBuilds?.ios, env.lastBuilds?.android] {
      times.append(time(build?.startedAt))
      times.append(time(build?.finishedAt))
    }
    times.append(time(env.build?.startedAt))
    return times.filter(\.isFinite).max()
  }

  static func failed(_ build: OversightBuild) -> Bool { (build.result ?? build.status) == "failed" }

  static func cause(_ build: OversightBuild) -> (key: String, file: String?, line: Int?) {
    if let at = build.diagnostics?.first(where: { ($0.file ?? "").isEmpty == false && $0.line != nil }) {
      return ("\(at.file!):\(at.line!)", at.file, at.line)
    }
    return (build.errorCode ?? "failed", nil, nil)
  }

  struct Streak {
    var signature: String
    var count: Int
    var body: (Int) -> String
  }

  static func failureStreak(_ platform: String, _ history: [OversightBuild]?) -> Streak? {
    guard let history, let head = history.first, failed(head) else { return nil }
    let headCause = cause(head)
    var count = 0
    for build in history {
      if !failed(build) || cause(build).key != headCause.key { break }
      count += 1
    }
    let name = platformName(platform)
    let body: (Int) -> String = { n in
      if let file = headCause.file, let line = headCause.line {
        let base = basename(file)
        let ext = base.split(separator: ".", omittingEmptySubsequences: false).last.map { $0.lowercased() } ?? ""
        let language = languages[ext]
        return "Same \(language.map { "\($0) " } ?? "\(name) build ")error \(n)x at \(base):\(line)"
      }
      if head.errorCode == "STIM_LAUNCH_FAILED" { return "App failed to launch on \(name) \(n)x in a row" }
      let code = head.errorCode.map { " (\($0))" } ?? ""
      return "\(name) build failed \(n)x in a row\(code)"
    }
    return Streak(signature: headCause.key, count: count, body: body)
  }

  final class Run {
    let input: OversightInput
    let prefs: OversightPrefs
    let now: Double
    let baseline: Bool
    var notifications: [OversightNotification] = []
    var wakeAt: Double?

    init(input: OversightInput, prefs: OversightPrefs, now: Double, baseline: Bool) {
      self.input = input
      self.prefs = prefs
      self.now = now
      self.baseline = baseline
    }

    func wake(_ at: Double) {
      if at > now { wakeAt = wakeAt.map { min($0, at) } ?? at }
    }

    func event(_ notification: OversightNotification) {
      if !baseline && !prefs.quiet && prefs.categories.contains(notification.category) {
        notifications.append(notification)
      }
    }

    func lasting(_ notification: OversightNotification) -> Bool {
      if baseline || !prefs.categories.contains(notification.category) { return true }
      if prefs.quiet { return false }
      notifications.append(notification)
      return true
    }

    func machineNotification(_ id: String, _ body: String) -> OversightNotification {
      OversightNotification(
        id: "machine:\(id)", category: .machine, title: input.machine, body: body, quiet: true, thread: nil,
        target: .machine)
    }
  }

  static func linkBody(_ kind: OversightLink) -> String {
    switch kind {
    case .offline: return "Offline"
    case .unpaired: return "Not paired: pair again"
    case .refused: return "Refused the connection: pair again or update"
    case .open: return ""
    }
  }

  static func overseeMachine(_ run: Run, _ previous: OversightState?, _ state: inout OversightState, awakeSince: Double) {
    let now = run.now
    if let kind = run.input.link, kind != .open {
      var held =
        (previous?.linkKind == kind ? previous?.link : nil) ?? OversightState.Held(since: now, notified: false)
      let due = max(held.since, awakeSince) + (kind == .offline ? offlineSettleMs : 0)
      if !held.notified && now < due {
        run.wake(due)
      } else if !held.notified {
        held.notified = run.lasting(run.machineNotification("link", linkBody(kind)))
      }
      state.link = held
      state.linkKind = kind
    }

    if let volumes = run.input.volumes {
      let lowest = volumes.map(\.freeBytes).min()
      if let lowest, lowest < (previous?.disk != nil ? diskRecoveredBytes : diskCriticalBytes) {
        var held = previous?.disk ?? OversightState.Held(since: now, notified: false)
        if !held.notified {
          let body = "\(Format.freeSpace(lowest)) free, below Stim's floor"
          held.notified = run.lasting(run.machineNotification("disk", body))
        }
        state.disk = held
      }
    } else if let disk = previous?.disk {
      state.disk = disk
    }

    state.memoryKnown = run.input.memoryPressure != nil || previous?.memoryKnown == true
    if run.input.memoryPressure == .critical {
      var held = previous?.memory ?? OversightState.Held(since: now, notified: false)
      if previous?.memoryKnown != true { held.notified = true }
      let due = held.since + memorySettleMs
      if !held.notified && now < due && !run.baseline {
        run.wake(due)
      } else if !held.notified {
        held.notified = run.lasting(run.machineNotification("memory", "Memory pressure is critical"))
      }
      state.memory = held
    } else if run.input.memoryPressure == nil, let memory = previous?.memory {
      state.memory = memory
    }
  }

  struct Look {
    var env: OversightEnvironment
    var devices: [SlotDevice]
    var driven: [SlotDevice]
    var notify: (OversightCategory, String, OversightTarget, String?) -> OversightNotification
  }

  static func deviceTarget(_ env: OversightEnvironment, _ device: SlotDevice) -> OversightTarget {
    .device(path: env.path, platform: device.platform, slot: device.slot)
  }

  static func overseeStart(_ run: Run, _ look: Look, _ entry: inout OversightState.Workspace) {
    let env = look.env
    if env.phase == "warming" && !entry.warmed {
      entry.warmed = true
      run.event(look.notify(.started, "Warming on \(run.input.machine)", .workspace(path: env.path), nil))
    }
    guard let first = look.driven.first else { return }
    entry.drove = true
    entry.drivenAt = run.now
    entry.finished = false
    if entry.driveNotified { return }
    entry.driveNotified = true
    let tool = first.activity?.driver?.tool ?? "An agent"
    let body = "\(tool) started driving \(first.model) on \(run.input.machine)"
    run.event(look.notify(.started, body, deviceTarget(env, first), nil))
  }

  static func overseeProgress(_ run: Run, _ look: Look, _ entry: inout OversightState.Workspace) {
    let env = look.env
    let now = run.now
    let idle = !env.live && (env.phase == nil || env.phase == "idle")
    let building = env.build?.state == "running"
    let newest = newestBuild(env)
    let green = newest?.status == "ok"
    let releasedGreen = look.driven.isEmpty && green
    let quietSince = lastActivityAt(env, look.devices, [entry.errorsAt, look.driven.isEmpty ? entry.drivenAt : nil])
    if let stuckAt = entry.stuckAt, let quietSince, quietSince > stuckAt { entry.stuckAt = nil }

    if entry.drove, releasedGreen, let newest, !building, let quietSince, !entry.finished {
      let due = quietSince + finishSettleMs
      if !idle && now < due {
        run.wake(due)
      } else {
        entry.finished = true
        let body = "Agent stopped after a green \(platformName(newest.platform ?? "android")) build"
        run.event(look.notify(.finished, body, .workspace(path: env.path), nil))
      }
    }
    if idle || entry.finished {
      entry.drove = false
      entry.driveNotified = false
    }
    if idle {
      entry.warmed = false
      entry.finished = false
    }

    guard let device = look.driven.first ?? look.devices.first(where: \.running) else { return }
    guard entry.drove, device.running, !building, let quietSince, !releasedGreen else { return }
    if entry.stuckAt != nil { return }
    let due = quietSince + Double(run.prefs.stuckMinutes) * 60_000
    if now < due { return run.wake(due) }
    let minutes = Int(((now - quietSince) / 60_000).rounded(.down))
    let after = green && newest != nil ? " after a green \(platformName(newest!.platform ?? "android")) build" : ""
    let body = "No agent activity for \(minutes) min\(after); \(device.model) still up"
    if run.lasting(look.notify(.stuck, body, deviceTarget(env, device), nil)) { entry.stuckAt = quietSince }
  }

  static func overseeLoops(
    _ run: Run, _ look: Look, _ entry: inout OversightState.Workspace, _ prev: OversightState.Workspace?
  ) {
    for platform in ["ios", "android"] {
      let history = platform == "ios" ? look.env.builds?.ios : look.env.builds?.android
      guard let streak = failureStreak(platform, history) else { continue }
      var loop: OversightState.Loop
      if let before = prev?.loops[platform], before.signature == streak.signature, streak.count >= loopCount {
        loop = before
      } else {
        loop = OversightState.Loop(signature: streak.signature, notified: false)
      }
      if streak.count >= loopCount && !loop.notified {
        let target = OversightTarget.build(path: look.env.path, platform: platform)
        loop.notified = run.lasting(look.notify(.looping, streak.body(streak.count), target, "looping-\(platform)"))
      }
      entry.loops[platform] = loop
    }
  }

  static func overseeMerge(
    _ run: Run, _ look: Look, _ entry: inout OversightState.Workspace, _ prev: OversightState.Workspace?
  ) {
    let env = look.env
    if let lookup = run.input.pullRequests[env.path] {
      let known = entry.pr
      let current = lookup.map {
        OversightState.PullRequest(
          number: $0.number, ready: $0.state == "open" && !$0.draft, merged: $0.state == "merged")
      }
      if let pr = lookup, let current, !isNotLookedUp(known) {
        let url = OversightTarget.url(path: env.path, url: pr.url)
        var knownPR: OversightState.PullRequest?
        if case .some(let k) = known { knownPR = k }
        let same = knownPR?.number == pr.number
        if current.ready && !(same && knownPR!.ready) {
          run.event(look.notify(.finished, "PR #\(pr.number) is ready for review", url, nil))
        }
        if current.merged && !(same && knownPR!.merged) && !entry.mergeNotified {
          entry.mergeNotified = true
          run.event(look.notify(.finished, "PR #\(pr.number) merged", url, nil))
        }
      } else if current?.merged == true {
        entry.mergeNotified = true
      }
      entry.pr = current.map { .some($0) } ?? OversightState.PullRequestLookup.none
    }
    if prev == nil {
      if entry.mergedInto != nil { entry.mergeNotified = true }
    } else if entry.mergedInto == nil {
      if env.worktree?.git != nil && !entry.pr.merged { entry.mergeNotified = false }
    } else if prev?.mergedInto == nil && !entry.mergeNotified {
      entry.mergeNotified = true
      run.event(look.notify(.finished, "Merged into \(entry.mergedInto!)", .workspace(path: env.path), nil))
    }
  }

  private static func isNotLookedUp(_ lookup: OversightState.PullRequestLookup) -> Bool {
    if case .notLookedUp = lookup { return true }
    return false
  }

  static func overseeWorkspace(
    _ run: Run, _ env: OversightEnvironment, _ status: OversightStatus, _ prev: OversightState.Workspace?
  ) -> OversightState.Workspace {
    let errors = env.logs?.errorsSinceMarker ?? 0
    let git = env.worktree?.git
    var entry = OversightState.Workspace(
      seenAt: run.now,
      warmed: prev?.warmed ?? false,
      drove: prev?.drove ?? false,
      drivenAt: prev?.drivenAt,
      driveNotified: prev?.driveNotified ?? false,
      errors: errors,
      errorsAt: prev.map { $0.errors != errors ? run.now : $0.errorsAt } ?? nil,
      stuckAt: prev?.stuckAt,
      finished: prev?.finished ?? false,
      loops: [:],
      pr: prev?.pr ?? .notLookedUp,
      mergedInto: git != nil ? git!.mergedInto : prev?.mergedInto,
      mergeNotified: prev?.mergeNotified ?? false)
    let title = title(env, status: status)
    let machine = run.input.machine
    let notify: (OversightCategory, String, OversightTarget, String?) -> OversightNotification = {
      category, body, target, id in
      OversightNotification(
        id: "\(id ?? category.rawValue):\(env.path)", category: category, title: title, body: body,
        quiet: true, thread: category == .started ? "started:\(machine)" : nil, target: target)
    }
    let devices = devices(env)
    let driven = devices.filter { agentDriven($0, ownLeases: run.input.ownLeases) }
    let look = Look(env: env, devices: devices, driven: driven, notify: notify)
    overseeStart(run, look, &entry)
    overseeProgress(run, look, &entry)
    overseeLoops(run, look, &entry, prev)
    overseeMerge(run, look, &entry, prev)
    return entry
  }

  /// The notifications a machine owes since `previous`, the state the last call returned. Nil `previous` records
  /// what is already true without notifying, so a restart stays quiet. Each workspace and machine problem notifies
  /// once per episode, under one id per category, so a later episode replaces it. Times are milliseconds since
  /// 1970; `awakeSince` restarts the offline settle time, for a checker that was not running.
  public static func oversee(
    previous: OversightState?, input: OversightInput, prefs: OversightPrefs, now: Double, awakeSince: Double = 0
  ) -> OversightResult {
    let run = Run(input: input, prefs: prefs, now: now, baseline: previous == nil)
    var state = OversightState()
    overseeMachine(run, previous, &state, awakeSince: awakeSince)
    if let status = input.status {
      for env in status.environments {
        state.workspaces[env.path] = overseeWorkspace(run, env, status, previous?.workspaces[env.path])
      }
      for (path, entry) in previous?.workspaces ?? [:]
      where state.workspaces[path] == nil && now - entry.seenAt < forgetMs {
        state.workspaces[path] = entry
      }
    } else {
      state.workspaces = previous?.workspaces ?? [:]
    }
    return OversightResult(state: state, notifications: run.notifications, wakeAt: run.wakeAt)
  }

  /// Whether `minuteOfDay` falls in quiet hours from `start` to `end`, minutes after midnight; they may span midnight.
  public static func inQuietHours(_ quietHours: QuietHours?, minuteOfDay: Int) -> Bool {
    guard let quietHours, quietHours.start != quietHours.end else { return false }
    let (start, end) = (quietHours.start, quietHours.end)
    return start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end
  }
}

/// Minutes after local midnight; an `end` before `start` spans midnight.
public struct QuietHours: Codable, Hashable, Sendable {
  public var start: Int
  public var end: Int

  public init(start: Int, end: Int) {
    self.start = start
    self.end = end
  }
}
