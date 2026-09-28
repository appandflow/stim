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
  public var command: StimCommand? {
    guard let workspace, let words = remedy?.split(separator: " ").map(String.init), words.first == "stim" else {
      return nil
    }
    return StimCommand(Array(words.dropFirst()), cwd: workspace)
  }

  /// False for a remedy that only explains, such as a `stim guide` topic.
  public var runnable: Bool { command.map { $0.arguments.first != "guide" } ?? false }
}

private let personIssues: Set<String> = ["port-not-ours", "supervisor-unverified", "browser-unverified", "avd-unchecked"]
private let signingCodes: Set<String> = [
  "STIM_NO_SIGNING_IDENTITY", "STIM_CODESIGN_FAILED", "STIM_NO_PROFILE", "STIM_PROFILE_MISMATCH",
]
private let budgetCodes: Set<String> = [
  "STIM_LOW_DISK", "STIM_AT_CAPACITY", "STIM_BUDGET_MAX_LIVE_WORKSPACES", "STIM_BUDGET_MAX_COMMITTED_MEMORY_GB",
  "STIM_BUDGET_HARD_FLOOR_DISK_GB", "STIM_BUDGET_MIN_FREE_DISK_GB",
]
private let diskFloorBytes: Double = 5e9
private let loopCount = 3
private let workEvidence = ["agent-action", "metro-bundle", "workspace-use"]
private let languages = [
  "swift": "Swift", "m": "Objective-C", "mm": "Objective-C++", "kt": "Kotlin", "java": "Java", "c": "C", "cc": "C++",
  "cpp": "C++", "h": "C", "hpp": "C++", "js": "JavaScript", "ts": "TypeScript", "tsx": "TypeScript",
  "gradle": "Gradle", "kts": "Gradle",
]


private func epochMs(_ text: String?) -> Double? {
  text.flatMap(parseTimestamp).map { $0.timeIntervalSince1970 * 1000 }
}

private func formatFreeBytes(_ bytes: Double) -> String {
  if bytes >= 1e12 { return String(format: "%.1f TB", bytes / 1e12) }
  let gb = bytes / 1e9
  return gb >= 100 ? "\(Int(gb.rounded())) GB" : String(format: "%.1f GB", gb)
}

private func runItem(_ env: Workspace, _ platform: String, _ build: LastBuild) -> NeedsAttentionItem? {
  let code = build.errorCode ?? ""
  let name = platformName(platform)
  let body: String
  if signingCodes.contains(code) {
    body = "\(name) signing or provisioning failed (\(code))"
  } else if budgetCodes.contains(code) {
    body = "\(name) run refused by the machine's budget (\(code))"
  } else if code == "STIM_CONFIG_CORRUPT" {
    body = "\(name) run refused: Stim's config is corrupt"
  } else if code == "STIM_EAS_BUILD_MISSING" {
    body = "No compatible EAS build for \(name); starting one is billable"
  } else {
    return nil
  }
  return NeedsAttentionItem(
    id: "run-\(platform):\(env.path)", category: .attention,
    severity: code == "STIM_EAS_BUILD_MISSING" ? "warning" : "error", workspace: env.path, body: body, remedy: nil)
}

private func loopItem(_ env: Workspace, _ platform: String) -> NeedsAttentionItem? {
  let history = env.builds?.builds(for: platform) ?? []
  func failed(_ entry: BuildHistoryEntry) -> Bool { entry.result == "failed" }
  func cause(_ build: LastBuild) -> (key: String, at: BuildDiagnostic?) {
    if let at = build.diagnostics?.first(where: { $0.file != nil && $0.line != nil }) {
      return ("\(at.file!):\(at.line!)", at)
    }
    return (build.errorCode ?? "failed", nil)
  }
  guard let head = history.first, failed(head) else { return nil }
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

  var driven: Bool { running && activity?.state == "driven" }
}

private let simulatorModel = try! NSRegularExpression(pattern: #"\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$"#)

/// The oversight rules' device list: each slot's simulator and emulator, then the owned Chrome.
private func overseenDevices(_ env: Workspace) -> [OverseenDevice] {
  var out: [OverseenDevice] = []
  func add(_ ios: IosDevice?, _ android: AndroidDevice?) {
    if let ios {
      let range = NSRange(ios.name.startIndex..., in: ios.name)
      let model = simulatorModel.firstMatch(in: ios.name, range: range).flatMap { Range($0.range(at: 1), in: ios.name) }
        .map { String(ios.name[$0]) }
      out.append(OverseenDevice(model: model ?? "iOS Simulator", running: ios.state == "Booted", activity: ios.activity, web: false))
    }
    if let android {
      out.append(
        OverseenDevice(
          model: android.physical ? "Android device" : "Android Emulator", running: android.state == "detected",
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

private func stuckItem(_ env: Workspace, now: Double, stuckMinutes: Int) -> NeedsAttentionItem? {
  let devices = overseenDevices(env)
  guard let driven = devices.first(where: \.driven), env.build?.isRunning != true,
    let since = quietSince(env, devices), now - since >= Double(stuckMinutes) * 60_000
  else { return nil }
  let minutes = Int(((now - since) / 60_000).rounded(.down))
  return NeedsAttentionItem(
    id: "stuck:\(env.path)", category: .stuck, severity: "warning", workspace: env.path,
    body: "No agent activity for \(minutes) min; \(driven.model) still up", remedy: nil)
}

private func workspaceItems(_ env: Workspace, now: Double, stuckMinutes: Int, easSessionMinutes: Int)
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
    let run = last.flatMap { $0.status == "failed" && !building ? runItem(env, platform, $0) : nil }
    if let item = run ?? loopItem(env, platform) { items.append(item) }
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
  let driven = overseenDevices(env).contains(where: \.driven)
  for session in env.remoteDevices ?? [] {
    guard !driven, let started = epochMs(session.startedAt), now - started >= Double(easSessionMinutes) * 60_000
    else { continue }
    let minutes = Int(((now - started) / 60_000).rounded(.down))
    items.append(
      NeedsAttentionItem(
        id: "eas-\(session.sessionId):\(env.path)", category: .attention, severity: "warning", workspace: env.path,
        body: "EAS session running for \(minutes) min with no agent; billed while it runs", remedy: "stim stop"))
  }
  if let stuck = stuckItem(env, now: now, stuckMinutes: stuckMinutes) { items.append(stuck) }
  return items
}

/// The items, errors first, then the machine's, then live workspaces' before idle ones', each in status order. Log
/// errors, a single failed run, and issues an agent's next `stim` command repairs are left out: agents handle them.
/// `volumes` holds the free bytes of each volume Stim uses, nil when not measured.
public func needsAttention(
  _ environments: [Workspace], volumes: [Double]?, now: Date, stuckMinutes: Int, easSessionMinutes: Int
) -> [NeedsAttentionItem] {
  let nowMs = now.timeIntervalSince1970 * 1000
  var ranked: [(item: NeedsAttentionItem, scope: Int)] = []
  if let lowest = volumes?.min(), lowest < diskFloorBytes {
    ranked.append(
      (
        NeedsAttentionItem(
          id: "machine:disk", category: .machine, severity: "error", workspace: nil,
          body: "\(formatFreeBytes(lowest)) free, below Stim's floor", remedy: nil), 0
      ))
  }
  for env in environments {
    for item in workspaceItems(env, now: nowMs, stuckMinutes: stuckMinutes, easSessionMinutes: easSessionMinutes) {
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
