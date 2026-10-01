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

/// What the main window shows when a device open request arrives.
public enum LaunchPage: Equatable, Sendable {
  case allDevices
  case workspace(String)
  case other
}

public enum LaunchResponse: Equatable, Sendable {
  case navigate
  case notice
}

/// A device open request comes from `stim ios` or `stim android` launching on its own, so it navigates only when
/// nothing the user was looking at is replaced: no main window was open, or the window already shows the launched
/// workspace or the All devices grid. Any other page keeps the selection and gets a notice card with a Show action.
public func launchResponse(page: LaunchPage, mainWindowOpen: Bool, workspacePath: String) -> LaunchResponse {
  guard mainWindowOpen else { return .navigate }
  switch page {
  case .allDevices: return .navigate
  case .workspace(let path): return path == workspacePath ? .navigate : .notice
  case .other: return .notice
  }
}

extension StatusPayload {
  /// The workspace that records the requested device, in its default devices or a slot.
  public func owner(of request: DeviceOpenRequest) -> (workspace: Workspace, device: DeviceRef)? {
    for env in environments {
      for device in env.devices {
        switch (request, device) {
        case (.simulator(let udid), .ios(_, let ios)) where ios.udid == udid:
          return (env, device)
        case (.emulator(let serial), .android(_, let android)) where android.serial == serial:
          return (env, device)
        default:
          continue
        }
      }
    }
    return nil
  }
}

/// A `stim-desktop://workspace?path=<path>` link, which `stim worktree warm`, `start`, `ios`, `android` and `web`
/// print. `platform` and `slot` name the device the run targeted; `slot` is nil for the default slot.
public struct WorkspaceOpenRequest: Equatable, Sendable {
  public var path: String
  public var platform: String?
  public var slot: String?

  public init(path: String, platform: String? = nil, slot: String? = nil) {
    self.path = path
    self.platform = platform
    self.slot = slot
  }
}

public enum WorkspaceLink: Equatable, Sendable {
  case workspace(WorkspaceOpenRequest)
  case malformed
}

/// Nil when `url` is not a workspace link; `.malformed` when it is one without an absolute `path` or with an
/// unknown `platform`.
public func workspaceLink(fromOpenURL url: URL) -> WorkspaceLink? {
  guard url.scheme == "stim-desktop", url.host == "workspace" else { return nil }
  let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
  func value(_ name: String) -> String? {
    items.first(where: { $0.name == name })?.value.flatMap { $0.isEmpty ? nil : $0 }
  }
  guard let path = value("path"), path.hasPrefix("/") else { return .malformed }
  let platform = value("platform")
  if let platform, !["ios", "android", "web"].contains(platform) { return .malformed }
  return .workspace(WorkspaceOpenRequest(path: path, platform: platform, slot: value("slot")))
}

extension StatusPayload {
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
