import Foundation

/// Stim Desktop's connection to its local stim-server, as a physical device's tile needs it.
public enum ServerLink: Equatable, Sendable {
  /// No stim-server runs for Stim Desktop.
  case off
  case connecting
  /// `features` is nil from a server older than the `features` hello field.
  case open(features: [String]?, capabilities: [String])
  /// The server is unreachable or refused Stim Desktop, with why.
  case unavailable(String)
}

/// What a leased physical device's tile shows: its screen through stim-server, or why it cannot.
public enum PhysicalScreen: Equatable, Sendable {
  /// `control` is nil when Take over is offered, else why the screen is view only.
  case stream(control: String?)
  case message(String, remedy: String? = nil)

  /// `now` decides an expired lease before `stim status` drops the device.
  public init(device: DeviceRef, link: ServerLink, now: Date) {
    let command = device.platform == "ios" ? "stim ios --device" : "stim android --device"
    if let expires = device.leaseExpiresAt, expires <= now {
      self = .message("The workspace's lease on this device ended.", remedy: command)
      return
    }
    guard device.isRunning else {
      switch device.state {
      case "disconnected":
        self = .message(
          device.platform == "ios"
            ? "Disconnected. Plug the iPhone into this Mac with a USB cable."
            : "Disconnected. Plug the phone into this Mac and allow USB debugging.")
      default: self = .message("Stim cannot tell whether this device is connected.")
      }
      return
    }
    switch link {
    case .off:
      self = .message("Turn on Serve to phones on the Phones page to see this device's screen.")
    case .connecting:
      self = .message("Connecting to stim-server")
    case .unavailable(let reason):
      self = .message(reason)
    case .open(let features, let capabilities):
      guard features?.contains("physical-\(device.platform)") == true else {
        self = .message("Update stim-server to see this device's screen.", remedy: "npm install --global @stim-cli/server@latest")
        return
      }
      if device.platform == "ios" {
        self = .stream(control: "stim-server shows an iPhone's screen but does not drive it.")
      } else if !capabilities.contains("control") {
        self = .stream(control: "Stim Desktop's stim-server pairing is read only.")
      } else {
        self = .stream(control: nil)
      }
    }
  }

  public var canControl: Bool { self == .stream(control: nil) }
}

/// What a key press sends to a physical device with `input.text`: printable ASCII as typed, and Return, Tab and
/// Delete as the `\n`, `\t` and `\b` the protocol reserves for them. Nil for other keys, which it has no way to send.
public func physicalInputText(characters: String?, keyCode: UInt16) -> String? {
  switch keyCode {
  case 0x24, 0x4C: return "\n"
  case 0x30: return "\t"
  case 0x33: return "\u{8}"
  default: break
  }
  guard let characters, !characters.isEmpty,
    characters.unicodeScalars.allSatisfy({ (32..<127).contains($0.value) })
  else { return nil }
  return characters
}
