import Foundation

/// The simulator UDID in a `stim-desktop://open?udid=<UDID>` URL, which
/// `stim ios` opens when `iosSimulatorApp` is `stim-desktop`.
public func simulatorUdid(fromOpenURL url: URL) -> String? {
  guard url.scheme == "stim-desktop", url.host == "open",
    let udid = URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?.first(where: { $0.name == "udid" })?.value,
    !udid.isEmpty
  else { return nil }
  return udid
}

extension StatusPayload {
  /// The workspace that records the iOS simulator, in its default devices or a slot.
  public func owner(ofSimulator udid: String) -> (workspace: Workspace, device: DeviceRef)? {
    for env in environments {
      for device in env.devices {
        if case .ios(_, let ios) = device, ios.udid == udid { return (env, device) }
      }
    }
    return nil
  }
}
