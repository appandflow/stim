import Foundation

/// The unified worktree page rule, mirrored by `apps/mobile/src/lib/worktree-page.ts`;
/// both replay `Tests/StimKitTests/Fixtures/worktree-page-vectors.json`.
public struct WorktreePage: Sendable {
  public struct Entry: Decodable, Hashable, Identifiable, Sendable {
    public var path: String
    public var platform: String
    public var id: String { "\(path)|\(platform)" }

    public init(path: String, platform: String) {
      self.path = path
      self.platform = platform
    }
  }

  public struct Device: Identifiable, Sendable {
    public var workspace: Workspace
    public var device: DeviceRef
    public var id: String { "\(workspace.path)|\(device.id)" }
    public var entry: Entry { Entry(path: workspace.path, platform: device.platform) }
  }

  public var apps: [Workspace]
  public var id: String { apps[0].path }
  public var identity: String { apps[0].worktree?.path ?? apps[0].path }
  public var isUnified: Bool { apps.count > 1 }
  public var actionKey: String { "worktree:\(identity)" }

  public init?(path: String, environments: [Workspace]) {
    guard let selected = environments.first(where: { $0.path == path }) else { return nil }
    if let root = selected.worktree?.path, !root.isEmpty {
      apps = environments.filter { $0.path == path || $0.worktree?.path == root }.sorted { $0.path < $1.path }
    } else {
      apps = [selected]
    }
  }

  public var projects: [String] { apps.map(Self.project) }

  public static func project(_ app: Workspace) -> String {
    if let root = app.worktree?.path, !root.isEmpty, app.path.hasPrefix(root + "/") {
      return String(app.path.dropFirst(root.count + 1))
    }
    return (app.path as NSString).lastPathComponent
  }

  public func lead(now: Date) -> Workspace {
    apps.enumerated().min {
      let a = Self.urgency($0.element.stage(now: now))
      let b = Self.urgency($1.element.stage(now: now))
      return a == b ? $0.offset < $1.offset : a < b
    }!.element
  }

  private static func urgency(_ stage: WorkspaceStage) -> Int {
    switch stage.label {
    case .buildFailed: 0
    case .running: stage.tone == .error ? 0 : 3
    case .building: 1
    case .warming: 2
    case .ready: 4
    case .stopped: 5
    }
  }

  public func subtitles(entries: [Entry]) -> [String?] {
    entries.map { entry in
      guard isUnified, Set(entries.filter { $0.platform == entry.platform }.map(\.path)).count > 1,
        let app = apps.first(where: { $0.path == entry.path })
      else { return nil }
      return Self.project(app)
    }
  }

  public func subtitle(for entry: Entry, among entries: [Entry]) -> String? {
    subtitles(entries: entries + [entry]).last ?? nil
  }

  public func appLabels(entries: [Entry]) -> [String] {
    let labels = apps.map { app in
      Self.platforms.filter { platform in entries.contains { $0.path == app.path && $0.platform == platform } }
        .map(platformName).joined(separator: " \u{00B7} ")
    }
    return apps.indices.map { i in
      if labels[i].isEmpty { return Self.project(apps[i]) }
      return labels.filter { $0 == labels[i] }.count > 1 ? labels[i] + " \u{00B7} " + Self.project(apps[i]) : labels[i]
    }
  }

  public var appLabels: [String] { appLabels(entries: buildEntries + canvasEntries) }

  private static let platforms = ["ios", "android", "macos", "web"]

  public var buildEntries: [Entry] {
    let entries = apps.flatMap { app in
      var platforms = app.runPlatforms.filter { $0 != "macos" && $0 != "web" }
      if let build = app.build, build.isRunning, !platforms.contains(build.platform), build.platform != "macos",
        build.platform != "web"
      {
        platforms.append(build.platform)
      }
      return (app.macos == nil ? [] : [Entry(path: app.path, platform: "macos")])
        + platforms.map { Entry(path: app.path, platform: $0) }
    }
    guard isUnified else { return entries }
    return entries.enumerated().sorted {
      let a = Self.platforms.firstIndex(of: $0.element.platform) ?? 4
      let b = Self.platforms.firstIndex(of: $1.element.platform) ?? 4
      return a == b ? $0.offset < $1.offset : a < b
    }.map(\.element)
  }

  public var orderedDevices: [Device] {
    apps.flatMap { app in app.devices.map { Device(workspace: app, device: $0) } }.enumerated().sorted {
      if DeviceRef.orderedBefore($0.element.device, $1.element.device) { return true }
      if DeviceRef.orderedBefore($1.element.device, $0.element.device) { return false }
      return $0.offset < $1.offset
    }.map(\.element)
  }

  public var canvasEntries: [Entry] {
    orderedDevices.map(\.entry) + apps.filter { $0.macos != nil }.map { Entry(path: $0.path, platform: "macos") }
  }

  public func canvasScrollTarget(selectedPath: String, focusedID: String?, devices: [Device]) -> String? {
    let selectedDevices = devices.filter { $0.workspace.path == selectedPath }
    let device = selectedDevices.first { $0.device.id == focusedID } ?? selectedDevices.first
    let card = apps.first { $0.path == selectedPath && $0.macos != nil }.map { "macos|\($0.path)" }
    let target = device?.id ?? card
    let first = apps.first { $0.macos != nil }.map { "macos|\($0.path)" } ?? devices.first?.id
    return target == first ? nil : target
  }

  public var soleErrorApp: Workspace? {
    let errors = apps.filter { ($0.logs?.errorsSinceMarker ?? 0) > 0 }
    return errors.count == 1 ? errors[0] : nil
  }

  public var errors: Int? {
    let counts = apps.compactMap { $0.logs?.errorsSinceMarker }
    return counts.isEmpty ? nil : counts.reduce(0, +)
  }

  public var agents: [AgentSession] {
    var seen = Set<String>()
    return AgentSession.associated(
      agents: apps.flatMap { $0.agents ?? [] }, endedAgents: apps.flatMap { $0.endedAgents ?? [] }
    ).filter { seen.insert($0.id).inserted }
  }

  public func usage(machine: MachineUsage?, sampled: [String: WorkspaceUsage] = [:]) -> WorkspaceUsage {
    let values = apps.map { app in
      app.usage(machine: machine).filling(cpuPercent: sampled[app.path]?.cpuPercent, footprintMb: sampled[app.path]?.memoryMb)
    }
    return WorkspaceUsage(
      cpuPercent: Self.sum(values.map(\.cpuPercent)), memoryMb: Self.sum(values.map(\.memoryMb)), diskBytes: diskBreakdown?.total)
  }

  private static func sum(_ values: [Double?]) -> Double? {
    let measured = values.compactMap { $0 }
    return measured.isEmpty ? nil : measured.reduce(0, +)
  }

  public var diskBreakdown: DiskBreakdown? {
    let worktree = apps.compactMap { $0.disk?.worktreeBytes }.max()
    let modules = apps.compactMap { $0.disk?.nodeModulesBytes }.max()
    let build = Self.sum(apps.map { $0.disk?.buildBytes })
    var parts: [DiskBreakdown.Part] = []
    if let worktree {
      if let modules, modules > 0, modules <= worktree {
        parts.append(.init(kind: .nodeModules, bytes: modules))
        if worktree > modules { parts.append(.init(kind: .worktree, bytes: worktree - modules)) }
      } else {
        parts.append(.init(kind: .worktree, bytes: worktree))
      }
    }
    if let build, build > 0 { parts.append(.init(kind: .build, bytes: build)) }
    return parts.isEmpty ? nil : DiskBreakdown(parts: parts)
  }

  /// Adds histories element-wise, aligning their newest samples; missing older samples contribute zero.
  public static func summedHistory(_ histories: [[Double]]) -> [Double] {
    let count = histories.map(\.count).max() ?? 0
    return (0..<count).map { index in
      histories.reduce(0) { sum, history in
        let aligned = index - (count - history.count)
        return sum + (aligned >= 0 ? history[aligned] : 0)
      }
    }
  }
}
