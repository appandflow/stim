import Foundation

/// What only a person can act on or decide, from one machine's status. `apps/mobile/src/lib/needs-attention.ts` holds
/// the same rule; both replay `Tests/StimKitTests/Fixtures/needs-attention-vectors.json`.
public struct NeedsAttentionItem: Decodable, Hashable, Sendable {
  public enum Category: String, Decodable, Sendable {
    case attention, stuck, looping, machine
  }

  /// Stable while the problem lasts; `stuck`, `looping` and `machine` items use the oversight notification ids.
  public var id: String
  /// The oversight notification category that covers the item; `attention` is for the rest.
  public var category: Category
  /// `error` or `warning`.
  public var severity: String
  /// The workspace path; nil for the machine.
  public var workspace: String?
  public var body: String
  /// A `stim` command to run from `workspace`, or nil when the fix is outside Stim.
  public var remedy: String?

  public var isError: Bool { severity == "error" }

  /// `remedy` as a command, run from the workspace.
  public var command: StimCommand? { remedyCommand(remedy, workspace: workspace) }

  /// False for a remedy that only explains, such as a `stim guide` topic.
  public var runnable: Bool { command?.isRunnable ?? false }
}

/// A remedy line such as `stim doctor --fix` as a command in `workspace`; nil unless it starts with `stim`.
public func remedyCommand(_ remedy: String?, workspace: String?) -> StimCommand? {
  guard let workspace, let words = remedy?.split(separator: " ").map(String.init), words.first == "stim" else {
    return nil
  }
  return StimCommand(Array(words.dropFirst()), cwd: workspace)
}

extension StimCommand {
  /// False for a command that only explains, such as a `stim guide` topic.
  public var isRunnable: Bool { arguments.first != "guide" }

  /// Whether it is `stim doctor --fix`, which asks for confirmation first.
  public var isFix: Bool { arguments.contains("--fix") }
}

private let personIssues: Set<String> = ["port-not-ours", "supervisor-unverified", "browser-unverified", "avd-unchecked"]
private let signingCodes: Set<String> = [
  "STIM_NO_SIGNING_IDENTITY", "STIM_CODESIGN_FAILED", "STIM_NO_PROFILE", "STIM_PROFILE_MISMATCH",
]
private let diskFloorBytes: Double = 5e9
private let loopCount = 3
let staleMs: Double = 24 * 60 * 60 * 1000
private let workEvidence = ["agent-action", "metro-bundle", "workspace-use"]
private let languages = [
  "swift": "Swift", "m": "Objective-C", "mm": "Objective-C++", "kt": "Kotlin", "java": "Java", "c": "C", "cc": "C++",
  "cpp": "C++", "h": "C", "hpp": "C++", "js": "JavaScript", "ts": "TypeScript", "tsx": "TypeScript",
  "gradle": "Gradle", "kts": "Gradle",
]

private func epochMs(_ text: String?) -> Double? {
  text.flatMap(parseTimestamp).map { $0.timeIntervalSince1970 * 1000 }
}

private func signingItem(_ env: Workspace, _ platform: String, _ build: LastBuild, now: Double) -> NeedsAttentionItem? {
  guard let code = build.errorCode, signingCodes.contains(code) else { return nil }
  if !env.live {
    guard let ended = epochMs(build.finishedAt ?? build.startedAt), now - ended < staleMs else { return nil }
  }
  return NeedsAttentionItem(
    id: "run-\(platform):\(env.path)", category: .attention, severity: "error", workspace: env.path,
    body: "\(platformName(platform)) signing or provisioning failed (\(code))", remedy: nil)
}

private func loopItem(_ env: Workspace, _ platform: String, now: Double) -> NeedsAttentionItem? {
  let history = env.builds?.builds(for: platform) ?? []
  func failed(_ entry: BuildHistoryEntry) -> Bool { entry.result == "failed" }
  func cause(_ build: LastBuild) -> (key: String, at: BuildDiagnostic?) {
    if let at = build.diagnostics?.first(where: { !($0.file ?? "").isEmpty && $0.line != nil }) {
      return ("\(at.file!):\(at.line!)", at)
    }
    return (build.errorCode ?? "failed", nil)
  }
  guard let head = history.first, failed(head) else { return nil }
  if !env.live {
    guard let ended = epochMs(head.build.finishedAt ?? head.build.startedAt), now - ended < staleMs else { return nil }
  }
  let headCause = cause(head.build)
  let count = history.prefix { failed($0) && cause($0.build).key == headCause.key }.count
  guard count >= loopCount else { return nil }
  let name = platformName(platform)
  let body: String
  if let at = headCause.at, let path = at.file, let line = at.line {
    let file = (path as NSString).lastPathComponent
    let language = languages[(file as NSString).pathExtension.lowercased()]
    body = "Same \(language.map { "\($0) " } ?? "\(name) build ")error \(count)x at \(file):\(line)"
  } else if head.build.errorCode == "STIM_LAUNCH_FAILED" {
    body = "App failed to launch on \(name) \(count)x in a row"
  } else {
    body = "\(name) build failed \(count)x in a row\(head.build.errorCode.map { " (\($0))" } ?? "")"
  }
  return NeedsAttentionItem(
    id: "looping-\(platform):\(env.path)", category: .looping, severity: "error", workspace: env.path, body: body,
    remedy: nil)
}

private struct OverseenDevice {
  var model: String
  var running: Bool
  var activity: DeviceActivity?
  var web: Bool

  /// Whether an agent drives it: a lease stim-server holds for a phone, named in `ownLeases`, is a person.
  func driven(by ownLeases: [String]) -> Bool {
    guard running, activity?.state == "driven" else { return false }
    let driver = activity?.driver
    return !(driver?.tool == "stim device lock" && driver?.since.map { !$0.isEmpty && ownLeases.contains($0) } == true)
  }
}

private func overseenDevices(_ env: Workspace) -> [OverseenDevice] {
  var out: [OverseenDevice] = []
  func add(_ ios: IosDevice?, _ android: AndroidDevice?) {
    if let ios {
      out.append(
        OverseenDevice(
          model: Format.simulatorModel(ios.name), running: DeviceRef.ios(slot: "default", ios).isRunning, activity: ios.activity,
          web: false)
      )
    }
    if let android {
      out.append(
        OverseenDevice(
          model: android.physical ? "Android device" : "Android Emulator",
          running: DeviceRef.android(slot: "default", android).isRunning,
          activity: android.activity, web: false))
    }
  }
  add(env.ios, env.android)
  for slot in env.slots ?? [] { add(slot.ios, slot.android) }
  if let web = env.web { out.append(OverseenDevice(model: "Chrome", running: web.running, activity: web.activity, web: true)) }
  return out
}

private func quietSince(_ env: Workspace, _ devices: [OverseenDevice]) -> Double? {
  var times: [Double?] = []
  for device in devices {
    if let recent = device.activity?.recent {
      times += workEvidence.map { epochMs(recent[$0]) }
      if device.web && device.activity?.state == "driven" { times.append(epochMs(recent["page-log"])) }
    } else {
      times.append(epochMs(device.activity?.lastActivityAt))
    }
    times.append(epochMs(device.activity?.driver?.since))
  }
  for build in [env.lastBuilds?.ios, env.lastBuilds?.android] {
    times += [epochMs(build?.startedAt), epochMs(build?.finishedAt)]
  }
  times.append(epochMs(env.build?.startedAt))
  return times.compactMap { $0 }.max()
}

private func stuckItem(_ env: Workspace, now: Double, stuckMinutes: Int, ownLeases: [String]) -> NeedsAttentionItem? {
  let devices = overseenDevices(env)
  guard let driven = devices.first(where: { $0.driven(by: ownLeases) }), env.build?.isRunning != true,
    let since = quietSince(env, devices), now - since >= Double(stuckMinutes) * 60_000
  else { return nil }
  let minutes = Int(((now - since) / 60_000).rounded(.down))
  let newest = [env.lastBuilds?.ios, env.lastBuilds?.android].compactMap { $0 }.reduce(nil as LastBuild?) { a, b in
    guard let a else { return b }
    return (epochMs(b.startedAt) ?? -.infinity) > (epochMs(a.startedAt) ?? -.infinity) ? b : a
  }
  let after = newest.flatMap { $0.status == "ok" ? " after a green \(platformName($0.platform)) build" : nil } ?? ""
  return NeedsAttentionItem(
    id: "stuck:\(env.path)", category: .stuck, severity: "warning", workspace: env.path,
    body: "No agent activity for \(minutes) min\(after); \(driven.model) still up", remedy: nil)
}

private func workspaceItems(
  _ env: Workspace, now: Double, stuckMinutes: Int, easSessionMinutes: Int, ownLeases: [String]
)
  -> [NeedsAttentionItem]
{
  var items: [NeedsAttentionItem] = []
  for issue in env.issues ?? [] where issue.severity != "info" && personIssues.contains(issue.code) {
    items.append(
      NeedsAttentionItem(
        id: "issue-\(issue.code)-\(issue.slot ?? DeviceRef.defaultSlot):\(env.path)", category: .attention,
        severity: issue.severity, workspace: env.path,
        body: issue.slot.map { "\($0): \(issue.message)" } ?? issue.message, remedy: issue.remedy))
  }
  for platform in ["ios", "android"] {
    let building = env.build?.isRunning == true && env.build?.platform == platform
    let last = env.lastBuilds?.build(for: platform)
    let signing = last.flatMap { $0.status == "failed" && !building ? signingItem(env, platform, $0, now: now) : nil }
    if let item = signing ?? loopItem(env, platform, now: now) { items.append(item) }
  }
  for device in env.physicalDevices ?? [] {
    guard let expires = epochMs(device.lease.expiresAt), expires <= now else { continue }
    let slot = device.slot == DeviceRef.defaultSlot ? "" : " --slot \(device.slot)"
    items.append(
      NeedsAttentionItem(
        id: "lease-\(device.platform)-\(device.slot):\(env.path)", category: .attention, severity: "warning",
        workspace: env.path, body: "Lease on \(device.name ?? device.model ?? device.id) expired",
        remedy: "stim device unlock \(device.platform)\(slot)"))
  }
  let driven = overseenDevices(env).contains { $0.driven(by: ownLeases) }
  for session in env.remoteDevices ?? [] {
    guard !driven, let started = epochMs(session.startedAt), now - started >= Double(easSessionMinutes) * 60_000
    else { continue }
    let minutes = Int(((now - started) / 60_000).rounded(.down))
    items.append(
      NeedsAttentionItem(
        id: "eas-\(session.sessionId):\(env.path)", category: .attention, severity: "warning", workspace: env.path,
        body: "EAS session running for \(minutes) min with no agent; billed while it runs", remedy: "stim stop"))
  }
  if let stuck = stuckItem(env, now: now, stuckMinutes: stuckMinutes, ownLeases: ownLeases) { items.append(stuck) }
  return items
}

/// The items, errors first, then the machine's, then live workspaces' before idle ones', each in status order. Log
/// errors, a single failed run, and issues an agent's next `stim` command repairs are left out: agents handle them.
/// `volumes` holds the free bytes of each volume Stim uses, nil when not measured. `ownLeases` is `grantedAt` of the
/// device leases stim-server holds for phones, so a person controlling a device is no agent.
public func needsAttention(
  _ environments: [Workspace], volumes: [Double]?, now: Date, stuckMinutes: Int, easSessionMinutes: Int,
  ownLeases: [String] = []
) -> [NeedsAttentionItem] {
  let nowMs = now.timeIntervalSince1970 * 1000
  var ranked: [(item: NeedsAttentionItem, scope: Int)] = []
  if let lowest = volumes?.min(), lowest < diskFloorBytes {
    ranked.append(
      (
        NeedsAttentionItem(
          id: "machine:disk", category: .machine, severity: "error", workspace: nil,
          body: "\(Format.freeSpace(lowest)) free, below Stim's floor", remedy: nil), 0
      ))
  }
  for env in environments {
    for item in workspaceItems(
      env, now: nowMs, stuckMinutes: stuckMinutes, easSessionMinutes: easSessionMinutes, ownLeases: ownLeases)
    {
      ranked.append((item, env.live ? 1 : 2))
    }
  }
  return ranked.enumerated().sorted { a, b in
    let (sa, sb) = (a.element.item.isError ? 0 : 1, b.element.item.isError ? 0 : 1)
    if sa != sb { return sa < sb }
    if a.element.scope != b.element.scope { return a.element.scope < b.element.scope }
    return a.offset < b.offset
  }.map(\.element.item)
}
