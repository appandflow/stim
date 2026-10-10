import Foundation

public enum TipTopic: String, CaseIterable, Codable, Sendable {
  case buildMachine, phone, tutorial, hideWorkspaces, statusFilter, replay, hostedSimulators, easProfile, macos, logs

  public var title: String {
    switch self {
    case .buildMachine: "Build on Another Mac"
    case .phone: "See Your Workspaces on Your Phone"
    case .tutorial: "Take the Stim Tutorial"
    case .hideWorkspaces: "Hide Workspaces You Don't Need"
    case .statusFilter: "Filter by Status"
    case .replay: "Replay What an Agent Did"
    case .hostedSimulators: "Run Simulators on Another Mac"
    case .easProfile: "Run on an EAS Development Build"
    case .macos: "Run Your Mac App with Stim"
    case .logs: "Ask for Just the Errors"
    }
  }

  public var body: String {
    switch self {
    case .buildMachine: "Send native builds to another Mac on your tailnet and run the app here."
    case .phone: "The Stim phone app shows your workspaces, builds and devices while you are away from this Mac."
    case .tutorial: "A short tour in a test app: two agents make two changes at once, each on its own simulator."
    case .hideWorkspaces: "Right-click a workspace and choose Hide to keep it out of the sidebar."
    case .statusFilter: "Choose which workspaces the sidebar lists: active, idle, not set up or archived."
    case .replay: "Stim records each simulator's screen with the agent's actions marked on a timeline you can scrub."
    case .hostedSimulators: "Another Mac on your tailnet can run simulators for your workspaces when this Mac is full."
    case .easProfile: "Install a completed EAS development build instead of compiling it here."
    case .macos: "Stim builds the Swift package as an isolated development app and captures its logs."
    case .logs: "One command shows only the errors from Metro, the app, the build and the device."
    }
  }

  public var actionTitle: String {
    switch self {
    case .buildMachine: "Add a Remote Mac"
    case .phone: "Pair a Phone"
    case .tutorial: "Open Tutorial"
    case .hideWorkspaces, .statusFilter: "View Options"
    case .replay: "Open Replay"
    case .hostedSimulators: "Add a Hosting Mac"
    case .easProfile, .macos, .logs: "Copy Prompt"
    }
  }

  public var nudgeTopic: NudgeTopic? {
    switch self {
    case .buildMachine: .buildMachine
    case .phone: .phone
    case .hostedSimulators: .hostedSimulators
    default: nil
    }
  }
}

public enum NudgeTopic: Sendable {
  case buildMachine, phone, hostedSimulators

  public var discoveryTypes: [DiscoveryType] {
    switch self {
    case .buildMachine: [.newMac, .slotWait]
    case .phone: [.away]
    case .hostedSimulators: [.capHit]
    }
  }
}

public struct UsageRecord: Codable, Equatable, Sendable {
  public var days: [String] = []
  public var workspaces: [String] = []
  public var builds: [String] = []
  public var since: Date?

  public init() {}

  public var isReal: Bool {
    Set(days).count >= Tips.minActiveDays
      && (Set(workspaces).count >= Tips.minRunningWorkspaces || Set(builds).count >= Tips.minBuilds)
  }

  /// Records one status update. Once the usage is real nothing changes, and the workspace and build lists stop at their
  /// thresholds, so repeated updates never rewrite an unchanged record. Builds that started before the first
  /// observation do not count.
  public mutating func observe(_ workspaces: [Workspace], now: Date, calendar: Calendar) {
    guard !isReal else { return }
    let since = since ?? now
    self.since = since
    let today = Tips.day(now, calendar: calendar)
    if !days.contains(today) { days = Array((days + [today]).sorted().suffix(30)) }
    for workspace in workspaces {
      if workspace.live, self.workspaces.count < Tips.minRunningWorkspaces, !self.workspaces.contains(workspace.path) {
        self.workspaces.append(workspace.path)
      }
      var starts: [String] = []
      if let build = workspace.build, build.isRunning { starts.append(build.startedAt) }
      starts += [workspace.lastBuilds?.ios, workspace.lastBuilds?.android].compactMap { $0?.startedAt }
      starts += ((workspace.builds?.ios ?? []) + (workspace.builds?.android ?? [])).map { $0.build.startedAt }
      for start in starts where parseTimestamp(start).map({ $0 >= since }) == true {
        let id = workspace.path + "|" + start
        if builds.count < Tips.minBuilds, !builds.contains(id) { builds.append(id) }
      }
    }
  }
}

public struct TipInputs {
  public var machines: [String]?
  public var hosting: [String]?
  public var macs: [TailnetMac]?
  public var pairedPhones: Int?
  /// The Phone app feature flag; without it no phone tip applies.
  public var phoneApp = false
  public var tutorialCompleted = false
  public var sidebar = SidebarOptions()
  public var rows = 0
  public var workspaces: [Workspace] = []
  /// Whether a listed project has an `eas.json`, and whether one has a macOS app, from `ProjectCapabilities`.
  public var hasEASProject = false
  public var hasMacosTarget = false
  public var archived: [ArchivedWorkspace] = []
  /// Whether Stim Desktop's stim-server runs, which reads archived recordings.
  public var serverRunning = false
  public var now = Date()

  public init() {}
}

public struct TipState: Codable, Equatable, Sendable {
  public struct Current: Codable, Equatable, Sendable {
    public var topic: TipTopic
    public var day: String
  }

  public var current: Current?
  public var closedDay: String?
  public var lastShown: [TipTopic: Date] = [:]

  public init() {}
}

public enum BuildMachineEmptyState: CaseIterable, Sendable {
  case addMachine, tailscale
}

public enum Tips {
  /// Calendar days on which Desktop observed a status update.
  public static let minActiveDays = 3
  /// Distinct workspace paths observed live, as an alternative to the build threshold.
  public static let minRunningWorkspaces = 3
  /// Distinct path|startedAt build IDs observed, as an alternative to the workspace threshold.
  public static let minBuilds = 5
  public static let manyRows = 10

  public static func day(_ now: Date, calendar: Calendar) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: now)
    return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
  }

  public static func established(usage: UsageRecord, setupCompleted: Bool) -> Bool {
    usage.isReal && setupCompleted
  }

  public static func gate(usage: UsageRecord, setupCompleted: Bool, workspaces: [Workspace], enabled: Bool) -> Bool {
    established(usage: usage, setupCompleted: setupCompleted) && enabled
      && !workspaces.contains { $0.build?.isRunning == true }
  }

  public static func firstMac(_ macs: [TailnetMac]?) -> TailnetMac? {
    macs?.sorted { $0.dnsName < $1.dnsName }.first
  }

  /// A discovery prompt is skipped once the tip for its topic has been shown, so one nudge never comes from both.
  public static func suppressesDiscovery(_ type: DiscoveryType, lastShown: [TipTopic: Date]) -> Bool {
    type != .capHit && lastShown.contains { topic, _ in topic.nudgeTopic?.discoveryTypes.contains(type) == true }
  }

  public static func applicable(_ topic: TipTopic, inputs: TipInputs) -> Bool {
    switch topic {
    case .buildMachine: noMacPaired(inputs) && inputs.macs?.isEmpty == false
    case .phone: inputs.phoneApp && inputs.pairedPhones == 0
    case .tutorial: !inputs.tutorialCompleted
    case .hideWorkspaces: inputs.sidebar.hiddenWorkspaces.isEmpty && inputs.rows > manyRows
    case .statusFilter: inputs.sidebar.statuses == StatusFilter.defaultSelection
    case .replay: replayArchive(inputs) != nil
    case .hostedSimulators: noMacPaired(inputs) && inputs.macs?.isEmpty == false
    case .easProfile: inputs.hasEASProject
    case .macos: inputs.hasMacosTarget && !inputs.workspaces.contains { $0.macos != nil }
    case .logs: inputs.workspaces.contains { ($0.logs?.errorsSinceMarker ?? 0) > 0 }
    }
  }

  /// The newest archived workspace with unexpired recordings, which the replay tip opens. An archive whose path is a
  /// listed workspace again is skipped, since a link to that path opens the workspace instead.
  public static func replayArchive(_ inputs: TipInputs) -> ArchivedWorkspace? {
    guard inputs.serverRunning else { return nil }
    let listed = Set(inputs.workspaces.map(\.path))
    return ArchivedWorkspace.newestFirst(inputs.archived).first { archive in
      archive.bytes.recordings > 0 && !listed.contains(archive.projectRoot)
        && archive.expires.recordings.flatMap(parseTimestamp).map { $0 < inputs.now } != true
    }
  }

  private static func noMacPaired(_ inputs: TipInputs) -> Bool {
    inputs.machines?.isEmpty == true && inputs.hosting?.isEmpty == true
  }

  public static func taken(_ topic: TipTopic, states: [DiscoveryType: DiscoveryState], now: Date) -> Bool {
    topic.nudgeTopic?.discoveryTypes.contains { !Discovery.eligible(states[$0], now: now) } ?? false
  }

  public static func available(
    inputs: TipInputs, state: TipState, discoveries: [DiscoveryType: DiscoveryState], now: Date, calendar: Calendar
  ) -> [TipTopic] {
    TipTopic.allCases.filter { applicable($0, inputs: inputs) && !taken($0, states: discoveries, now: now) }
  }

  public static func select(
    inputs: TipInputs, state: inout TipState, discoveries: [DiscoveryType: DiscoveryState], now: Date, calendar: Calendar
  ) -> TipTopic? {
    let today = day(now, calendar: calendar)
    guard state.closedDay != today else { return nil }
    let topics = available(inputs: inputs, state: state, discoveries: discoveries, now: now, calendar: calendar)
    if let current = state.current, current.day == today, topics.contains(current.topic) { return current.topic }
    let topic = topics.min {
      (state.lastShown[$0] ?? .distantPast) < (state.lastShown[$1] ?? .distantPast)
    }
    if let topic { pick(topic, state: &state, now: now, calendar: calendar) }
    return topic
  }

  public static func next(
    inputs: TipInputs, state: inout TipState, discoveries: [DiscoveryType: DiscoveryState], now: Date, calendar: Calendar
  ) -> TipTopic? {
    guard state.closedDay != day(now, calendar: calendar) else { return nil }
    guard let current = state.current?.topic else {
      return select(inputs: inputs, state: &state, discoveries: discoveries, now: now, calendar: calendar)
    }
    let topics = available(inputs: inputs, state: state, discoveries: discoveries, now: now, calendar: calendar)
    let catalog = TipTopic.allCases
    let index = catalog.firstIndex(of: current)!
    for offset in 1..<catalog.count {
      let topic = catalog[(index + offset) % catalog.count]
      if topics.contains(topic) {
        pick(topic, state: &state, now: now, calendar: calendar)
        return topic
      }
    }
    return topics.contains(current) ? current : nil
  }

  private static func pick(
    _ topic: TipTopic, state: inout TipState, now: Date, calendar: Calendar
  ) {
    state.current = .init(topic: topic, day: day(now, calendar: calendar))
    state.lastShown[topic] = now
  }

  public static func visible(gate: Bool, noticeCount: Int, closedDay: String?, now: Date, calendar: Calendar) -> Bool {
    gate && noticeCount == 0 && closedDay != day(now, calendar: calendar)
  }

  public static func emptyState(
    gate: Bool, machines: [String]?, settingsError: String?, selectedMachine: String?, macs: [TailnetMac]?
  ) -> BuildMachineEmptyState? {
    guard gate, machines?.isEmpty == true, settingsError == nil, selectedMachine == nil, let macs else { return nil }
    return macs.isEmpty ? .tailscale : .addMachine
  }
}

public struct TipStore {
  private let defaults: UserDefaults

  public init(defaults: UserDefaults) { self.defaults = defaults }

  public var enabled: Bool {
    defaults.object(forKey: AppPreferences.Key.tipsEnabled) as? Bool ?? true
  }

  public var usage: UsageRecord {
    get {
      defaults.data(forKey: AppPreferences.Key.usageRecord).flatMap { try? JSONDecoder().decode(UsageRecord.self, from: $0) }
        ?? UsageRecord()
    }
    nonmutating set { defaults.set(try? JSONEncoder().encode(newValue), forKey: AppPreferences.Key.usageRecord) }
  }

  public var state: TipState {
    get {
      var state = TipState()
      state.current = defaults.data(forKey: "tips.current").flatMap {
        try? JSONDecoder().decode(TipState.Current.self, from: $0)
      }
      state.closedDay = defaults.string(forKey: "tips.closedDay")
      state.lastShown =
        defaults.data(forKey: "tips.lastShown").flatMap {
          try? JSONDecoder().decode([TipTopic: Date].self, from: $0)
        } ?? [:]
      return state
    }
    nonmutating set {
      guard newValue != state else { return }
      defaults.set(try? JSONEncoder().encode(newValue.current), forKey: "tips.current")
      defaults.set(newValue.closedDay, forKey: "tips.closedDay")
      defaults.set(try? JSONEncoder().encode(newValue.lastShown), forKey: "tips.lastShown")
    }
  }

  public func close(now: Date, calendar: Calendar) {
    var state = state
    state.closedDay = Tips.day(now, calendar: calendar)
    self.state = state
  }
}
