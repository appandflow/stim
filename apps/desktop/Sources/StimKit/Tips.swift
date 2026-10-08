import Foundation

public enum TipTopic: String, CaseIterable, Codable, Sendable {
  case buildMachine, phone, tutorial, hideWorkspaces, statusFilter, replay, hostedSimulators

  public var title: String {
    switch self {
    case .buildMachine: "Build on another Mac"
    case .phone: "See your workspaces on your phone"
    case .tutorial: "Take the Stim tutorial"
    case .hideWorkspaces: "Hide workspaces you don't need"
    case .statusFilter: "Filter by status"
    case .replay: "Replay what an agent did"
    case .hostedSimulators: "Run simulators on another Mac"
    }
  }

  public var actionTitle: String {
    switch self {
    case .buildMachine: "Add a remote Mac"
    case .phone: "Pair a phone"
    case .tutorial: "Open tutorial"
    case .hideWorkspaces, .statusFilter: "View options"
    case .replay: "Open workspace"
    case .hostedSimulators: "Add a hosting Mac"
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
    case .buildMachine: [.slowCold, .newMac, .slotWait]
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
    case .buildMachine: inputs.machines?.isEmpty == true && inputs.macs?.isEmpty == false
    case .phone: inputs.phoneApp && inputs.pairedPhones == 0
    case .tutorial: !inputs.tutorialCompleted
    case .hideWorkspaces: inputs.sidebar.hiddenWorkspaces.isEmpty && inputs.rows > manyRows
    case .statusFilter: inputs.sidebar.statuses == StatusFilter.defaultSelection
    case .replay: inputs.workspaces.contains { $0.recording?.enabled == true }
    case .hostedSimulators: inputs.hosting?.isEmpty == true && inputs.macs?.isEmpty == false
    }
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
