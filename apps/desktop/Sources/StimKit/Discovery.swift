import CryptoKit
import Foundation

public enum DiscoveryType: String, CaseIterable, Sendable {
  case slowCold = "offload.slowCold"
  case newMac = "tailnet.newMac"
  case slotWait = "builds.slotWait"
  case lowWithCaches = "disk.lowWithCaches"
  case capHit = "devices.capHit"
  case away = "phone.away"
}

public enum DiscoveryState: Equatable, Sendable {
  case shown
  case snoozed(until: Date)
  case never

  public static func parse(_ value: String?) -> Self? {
    guard let value else { return nil }
    if value == "never" { return .never }
    if value.hasPrefix("snoozed:"), let until = parseTimestamp(String(value.dropFirst(8))) {
      return .snoozed(until: until)
    }
    return .shown
  }

  public var encoded: String {
    switch self {
    case .shown: return "shown"
    case .never: return "never"
    case .snoozed(let until):
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      return "snoozed:" + formatter.string(from: until)
    }
  }
}

public enum DiscoveryAction: Hashable, Sendable {
  case addMachine(mac: TailnetMac?, hostedSimulators: Bool)
  case runOnAuto(workspaceID: String, platform: String?)
  case reviewCaches, pairPhone
}

public struct DiscoveryPrompt: Hashable, Sendable {
  public enum Surface: Sendable { case banner, notification }
  public var type: DiscoveryType
  public var title: String
  public var detail: String?
  public var actionTitle: String
  public var action: DiscoveryAction
  public var surface: Surface

  public var secondaryAction: DiscoveryAction? { type == .lowWithCaches ? .reviewCaches : nil }
}

public enum Discovery {
  public static let week: TimeInterval = 7 * 24 * 60 * 60

  public static func eligible(_ state: DiscoveryState?, now: Date) -> Bool {
    switch state {
    case nil: return true
    case .snoozed(let until): return until <= now
    case .shown, .never: return false
    }
  }

  public static func snooze(now: Date) -> DiscoveryState { .snoozed(until: now.addingTimeInterval(week)) }

  public static func dismissed(previous: DiscoveryState?, now: Date) -> DiscoveryState {
    if case .snoozed = previous { return .shown }
    return snooze(now: now)
  }

  public static func fresh(_ type: DiscoveryType, rememberedAt: Date, now: Date) -> Bool {
    switch type {
    case .away: return now.timeIntervalSince(rememberedAt) <= 10 * 60
    case .capHit: return now.timeIntervalSince(rememberedAt) <= 6 * 60 * 60
    default: return true
    }
  }

  public static func gate(
    workspaces: [Workspace], setupCompleted: Bool, launches: Int, lastShown: Date?, now: Date, calendar: Calendar
  ) -> Bool {
    setupCompleted && launches >= 2 && !workspaces.contains { $0.build?.isRunning == true }
      && (lastShown.map { !calendar.isDate($0, inSameDayAs: now) } ?? true)
  }

  public static func select(
    _ prompts: [DiscoveryPrompt], states: [DiscoveryType: DiscoveryState], now: Date, bannersAvailable: Bool = true
  ) -> DiscoveryPrompt? {
    for type in DiscoveryType.allCases where eligible(states[type], now: now) {
      if let prompt = prompts.first(where: { $0.type == type && (bannersAvailable || $0.surface != .banner) }) { return prompt }
    }
    return nil
  }

  public static func slowCold(
    placements: [BuildPlacements.Placement], machines: [String], macs: [TailnetMac], now: Date
  ) -> DiscoveryPrompt? {
    guard machines.isEmpty, let mac = firstMac(macs) else { return nil }
    let cold = placements.filter {
      $0.decision == .here && $0.failed != true && ($0.buildMs ?? 0) > 0 && recent($0.at, now: now)
    }
    guard cold.count >= 3 else { return nil }
    let average = cold.reduce(0) { $0 + ($1.buildMs ?? 0) } / Double(cold.count)
    guard average > 180_000 else { return nil }
    return banner(
      .slowCold, title: "Cold builds take ~\(Int((average / 60_000).rounded())) min. Build on \(mac.machine) instead?",
      mac: mac)
  }

  public struct NewMacResult: Sendable {
    public var seen: Set<String>
    public var prompt: DiscoveryPrompt?
  }

  public static func newMac(
    macs: [TailnetMac], seen: Set<String>?, machines: [String], hosting: [String], now: Date
  ) -> NewMacResult {
    let updated = (seen ?? []).union(macs.map(\.id))
    guard let seen,
      let mac = macs.sorted(by: { $0.dnsName < $1.dnsName }).first(where: { mac in
        !seen.contains(mac.id) && !(machines + hosting).contains { OffloadMachines.names($0, mac) }
      })
    else { return NewMacResult(seen: updated, prompt: nil) }
    return NewMacResult(seen: updated, prompt: banner(.newMac, title: "\(mac.hostName) joined your tailnet", mac: mac))
  }

  public static func slotWait(
    placements: [BuildPlacements.Placement], macs: [TailnetMac], now: Date
  ) -> DiscoveryPrompt? {
    let count = placements.filter { ($0.slotWaitMs ?? 0) > 60_000 && recent($0.at, now: now) }.count
    guard count >= 3 else { return nil }
    return banner(
      .slotWait, title: "Builds waited more than a minute for a build slot", detail: "\(count) builds this week",
      mac: firstMac(macs))
  }

  public static func lowWithCaches(plan: PressurePlan?, cacheBytes: Int64?, mac: TailnetMac?) -> DiscoveryPrompt? {
    guard plan != nil, let cacheBytes, cacheBytes > 20 * 1_073_741_824 else { return nil }
    let gb = Int((Double(cacheBytes) / 1_073_741_824).rounded())
    return banner(.lowWithCaches, title: "Native caches use \(gb) GB. Build on another Mac?", mac: mac)
  }

  public static func refusedForCapacity(lines: [String], exitStatus: Int32) -> Bool {
    exitStatus != 0 && lines.contains { $0.contains("STIM_AT_CAPACITY") }
  }

  /// The workspace and platform a device-limit event happened in, and when.
  public struct CapHitSource: Equatable, Sendable {
    public var at: Date
    public var workspaceID: String?
    public var platform: String?

    public init(at: Date, workspaceID: String?, platform: String?) {
      self.at = at
      self.workspaceID = workspaceID
      self.platform = platform
    }
  }

  public static func capHitSource(events: [CapacityRefusal], waits: [CapacityWait] = [], now: Date) -> CapHitSource? {
    func fresh(_ at: String) -> Date? {
      parseTimestamp(at).flatMap {
        now.timeIntervalSince($0) >= 0 && Discovery.fresh(.capHit, rememberedAt: $0, now: now) ? $0 : nil
      }
    }
    let refusals = events.filter { $0.kind == "device" }.compactMap { event in
      fresh(event.at).map { CapHitSource(at: $0, workspaceID: event.workspace, platform: event.platform) }
    }
    let longWaits = waits.filter { $0.kind == "device-wait" && ($0.ms ?? 0) >= 60_000 }.compactMap { wait in
      fresh(wait.at).map { CapHitSource(at: $0, workspaceID: wait.workspace, platform: wait.platform) }
    }
    return (refusals + (longWaits.count >= 3 ? longWaits : [])).max { $0.at < $1.at }
  }

  /// `hosts` are the hosting Macs approved for device-host (nil when that is not known, which shows nothing). With
  /// one approved the prompt offers to use it instead of setting up; setup is offered only when none is approved.
  /// `isRemote` says whether the workspace's Run on already leaves this Mac.
  public static func capHit(
    source: CapHitSource, mac: TailnetMac?, hosts: [String]?, isRemote: (String, String?) -> Bool = { _, _ in false }
  ) -> DiscoveryPrompt? {
    guard let hosts else { return nil }
    if hosts.isEmpty {
      return banner(
        .capHit, title: "Device limit reached. Run simulators on \(mac?.machine ?? "another Mac")?", mac: mac,
        hostedSimulators: true)
    }
    guard let workspaceID = source.workspaceID, !isRemote(workspaceID, source.platform) else { return nil }
    return DiscoveryPrompt(
      type: .capHit,
      title: "Device limit reached. Run on \(hosts.count == 1 ? machineName(hosts[0]) : "a hosting Mac")?",
      detail: runOnAutoPlatforms(source.platform).count == 1
        ? "Project setting: \(runOnAutoPlatforms(source.platform)[0]).remote = auto"
        : "Project settings: remote = auto",
      actionTitle: "Use Auto",
      action: .runOnAuto(workspaceID: workspaceID, platform: source.platform), surface: .banner)
  }

  public static func runOnAutoPlatforms(_ platform: String?) -> [String] {
    let supported = ["ios", "android"]
    return platform.flatMap { supported.contains($0) ? [$0] : nil } ?? supported
  }

  public static func workspaceID(path: String) -> String {
    SHA256.hash(data: Data(URL(fileURLWithPath: path).standardizedFileURL.path.utf8)).prefix(8)
      .map { String(format: "%02x", $0) }.joined()
  }

  public static func away(pairedPhones: Int, durationMs: Double, idleSeconds: TimeInterval) -> DiscoveryPrompt? {
    guard pairedPhones == 0, durationMs > 600_000, idleSeconds > 300 else { return nil }
    return DiscoveryPrompt(
      type: .away, title: "Your build finished while you were away", detail: "Get these on your phone?",
      actionTitle: "Pair a Phone", action: .pairPhone, surface: .notification)
  }

  private static func recent(_ at: String, now: Date) -> Bool {
    guard let date = parseTimestamp(at) else { return false }
    return (0...week).contains(now.timeIntervalSince(date))
  }

  private static func firstMac(_ macs: [TailnetMac]) -> TailnetMac? {
    macs.sorted { $0.dnsName < $1.dnsName }.first
  }

  private static func banner(
    _ type: DiscoveryType, title: String, detail: String? = nil, mac: TailnetMac?, hostedSimulators: Bool = false
  ) -> DiscoveryPrompt {
    DiscoveryPrompt(
      type: type, title: title, detail: detail, actionTitle: "Set up",
      action: .addMachine(mac: mac, hostedSimulators: hostedSimulators), surface: .banner)
  }
}

public struct DiscoveryStore {
  private let defaults: UserDefaults

  public init(defaults: UserDefaults) { self.defaults = defaults }

  public func state(_ type: DiscoveryType) -> DiscoveryState? {
    let key = AppPreferences.Key.discovery(type)
    guard let value = defaults.object(forKey: key) else { return nil }
    return DiscoveryState.parse(value as? String ?? "")
  }

  public func set(_ state: DiscoveryState, for type: DiscoveryType) {
    defaults.set(state.encoded, forKey: AppPreferences.Key.discovery(type))
  }

  public var states: [DiscoveryType: DiscoveryState] {
    Dictionary(uniqueKeysWithValues: DiscoveryType.allCases.compactMap { type in state(type).map { (type, $0) } })
  }

  public var launches: Int { defaults.integer(forKey: AppPreferences.Key.discoveryLaunches) }

  public func launched() { defaults.set(launches + 1, forKey: AppPreferences.Key.discoveryLaunches) }

  public var lastShown: Date? {
    get { defaults.object(forKey: AppPreferences.Key.discoveryLastShown) as? Date }
    nonmutating set { defaults.set(newValue, forKey: AppPreferences.Key.discoveryLastShown) }
  }

  public var seenPeers: Set<String>? {
    get { defaults.stringArray(forKey: AppPreferences.Key.discoverySeenPeers).map(Set.init) }
    nonmutating set { defaults.set(newValue.map { $0.sorted() }, forKey: AppPreferences.Key.discoverySeenPeers) }
  }

  public var setupCompleted: Bool { defaults.bool(forKey: SetupGuideProgress.completedKey) }

  public func migrate() {
    let version = defaults.integer(forKey: AppPreferences.Key.discoveryMigrations)
    guard version < 1 else { return }
    if state(.capHit) == .shown { defaults.removeObject(forKey: AppPreferences.Key.discovery(.capHit)) }
    defaults.set(1, forKey: AppPreferences.Key.discoveryMigrations)
  }

  public func shown(_ prompt: DiscoveryPrompt, now: Date) {
    set(.shown, for: prompt.type)
    lastShown = now
  }
}
