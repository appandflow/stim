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
