import Foundation

/// The device in a `stim-desktop://open` URL: `?udid=<UDID>`, which `stim ios` opens when
/// `iosSimulatorApp` is `stim-desktop`, or `?serial=<serial>`, which `stim android` opens when
/// `androidEmulatorApp` is `stim-desktop`.
public enum DeviceOpenRequest: Equatable, Sendable {
  case simulator(udid: String)
  case emulator(serial: String)
}

public func deviceOpenRequest(fromOpenURL url: URL) -> DeviceOpenRequest? {
  guard url.scheme == "stim-desktop", url.host == "open",
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
  else { return nil }
  if let udid = items.first(where: { $0.name == "udid" })?.value, !udid.isEmpty {
    return .simulator(udid: udid)
  }
  if let serial = items.first(where: { $0.name == "serial" })?.value, !serial.isEmpty {
    return .emulator(serial: serial)
  }
  return nil
}

extension StatusPayload {
  public func lists(workspace path: String) -> Bool {
    environments.contains { $0.path == path || $0.worktree?.path == path }
      || unprovisionedWorktrees?.contains { $0.path == path } == true
  }
}

/// A legacy local `stim-desktop://workspace?path=<path>` link. `platform` and `slot` name the targeted device;
/// `slot` is nil for the default slot. `archive` names
/// one archived run of `path`, opened only when no live workspace matches.
public struct WorkspaceOpenRequest: Equatable, Sendable {
  public var path: String
  public var platform: String?
  public var slot: String?
  public var archive: String?

  public init(path: String, platform: String? = nil, slot: String? = nil, archive: String? = nil) {
    self.path = path
    self.platform = platform
    self.slot = slot
    self.archive = archive
  }
}

public enum WorkspaceLink: Equatable, Sendable {
  case workspace(WorkspaceOpenRequest)
  case shared(SharedWorkspaceOpenRequest)
  case malformed
}

public struct SharedWorkspaceOpenRequest: Equatable, Sendable {
  public var machine: String
  public var workspace: String
  public var platform: String?
  public var slot: String?
}

public func sharedWorkspaceRequest(from url: URL) -> SharedWorkspaceOpenRequest? {
  guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
  let https =
    components.scheme?.lowercased() == "https"
    && components.host?.lowercased() == "stim.appandflow.com"
    && (components.port == nil || components.port == 443)
    && ["/open", "/open/"].contains(components.path)
  let fallback = components.scheme == "stim-desktop" && components.host == "shared" && components.path.isEmpty
  guard https || fallback, components.user == nil, components.password == nil else { return nil }
  components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%20")
  let items = components.queryItems ?? []
  for key in ["v", "machine", "workspace", "platform", "slot"] {
    guard items.filter({ $0.name == key }).count <= 1 else { return nil }
  }
  func value(_ key: String) -> String? {
    items.first(where: { $0.name == key })?.value.flatMap { $0.isEmpty ? nil : $0 }
  }
  guard value("v") == "1", let machine = value("machine"),
    machine.range(
      of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      options: [.regularExpression, .caseInsensitive]) != nil,
    let workspace = value("workspace"), workspace.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil
  else { return nil }
  let platform = value("platform")
  if let platform, !["ios", "android", "macos", "web"].contains(platform) { return nil }
  let slot = value("slot")
  return SharedWorkspaceOpenRequest(
    machine: machine.lowercased(), workspace: workspace, platform: platform,
    slot: slot == "default" ? nil : slot)
}

/// Nil for unrelated URLs; malformed for an unsupported or incomplete local or shared workspace link.
public func workspaceLink(fromOpenURL url: URL) -> WorkspaceLink? {
  if (url.scheme?.lowercased() == "https" && url.host?.lowercased() == "stim.appandflow.com"
    && ["/open", "/open/"].contains(url.path)) || (url.scheme == "stim-desktop" && url.host == "shared")
  {
    return sharedWorkspaceRequest(from: url).map(WorkspaceLink.shared) ?? .malformed
  }
  guard url.scheme == "stim-desktop", url.host == "workspace" else { return nil }
  let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
  func value(_ name: String) -> String? {
    items.first(where: { $0.name == name })?.value.flatMap { $0.isEmpty ? nil : $0 }
  }
  guard let path = value("path"), path.hasPrefix("/") else { return .malformed }
  let platform = value("platform")
  if let platform, !["ios", "android", "macos", "web"].contains(platform) { return .malformed }
  return .workspace(WorkspaceOpenRequest(path: path, platform: platform, slot: value("slot"), archive: value("archive")))
}

extension StatusPayload {
  public func request(for link: SharedWorkspaceOpenRequest, homeId: String) -> WorkspaceOpenRequest? {
    guard homeId.lowercased() == link.machine,
      let workspace = environments.first(where: { $0.workspaceId == link.workspace })
    else { return nil }
    return WorkspaceOpenRequest(path: workspace.path, platform: link.platform, slot: link.slot)
  }

  /// The archive a link opens. An explicit `archive=` id opens at once; without one the newest archive of the path
  /// is used only once `waited` says the live workspace had its chance to appear in status.
  public func archive(for request: WorkspaceOpenRequest, waited: Bool) -> ArchivedWorkspace? {
    guard !environments.contains(where: { $0.path == request.path }) else { return nil }
    if let id = request.archive {
      return archived?.first { $0.id == id && $0.projectRoot == request.path }
    }
    guard waited else { return nil }
    return ArchivedWorkspace.newest(removedFrom: request.path, in: archived ?? [])
  }

  /// The workspace a link names, and the device of its platform and slot when it has one, a running one first.
  public func target(of request: WorkspaceOpenRequest) -> (workspace: Workspace, device: DeviceRef?)? {
    guard let env = environments.first(where: { $0.path == request.path }) else { return nil }
    let slot = request.slot ?? DeviceRef.defaultSlot
    let device = request.platform.flatMap { platform in
      env.orderedDevices.first { $0.platform == platform && $0.slot == slot }
    }
    return (env, device)
  }
}
