import Foundation

/// What a device tile says about its device: the header action it offers, a status line, and whether it is still working.
public struct DeviceTileStatus: Equatable, Sendable {
  public enum Phase: Equatable, Sendable {
    case live
    /// A physical device Stim cannot reach; the viewer explains why.
    case disconnected
    case booting
    case shutDown
    /// A hosted session that Stim placed but has not confirmed yet.
    case hostedStarting
    case hostedFailed
    case missing
  }

  public enum HeaderAction: String, Equatable, Sendable {
    case control = "Control"
    case view = "View"
  }

  public var phase: Phase
  /// Shown on the tile instead of a black frame; nil when the tile shows the device's screen or build.
  public var message: String?
  public var showsProgress: Bool
  public var headerAction: HeaderAction?

  /// `canControl` is whether the device's stream takes input; `building` is whether a build for the device runs.
  public init(device: DeviceRef, canControl: Bool, building: Bool) {
    self.init(
      platform: device.platform, hostedMachine: device.hostedMachine, state: device.state, isRunning: device.isRunning,
      isPhysical: device.isPhysical, canControl: canControl, building: building)
  }

  /// The same mapping from raw facts, for a surface that has no `DeviceRef`, such as a hosted macOS app. `platform` is
  /// `ios`, `android`, `web` or `macos`; a hosted `state` is `ready`, `stopped`, `unverified`, `unknown` or `unreachable`.
  public init(
    platform: String, hostedMachine: String?, state: String, isRunning: Bool, isPhysical: Bool = false, canControl: Bool,
    building: Bool
  ) {
    let noun = ["android": "emulator", "macos": "app", "web": "page"][platform] ?? "simulator"
    if let machine = hostedMachine {
      let name = machineName(machine)
      switch state {
      case "ready": self.init(.live, action: canControl ? .control : .view)
      case "stopped": self.init(.shutDown)
      case "unverified" where building:
        self.init(.hostedStarting, message: "Starting \(noun) on \(name)", progress: true)
      default: self.init(.hostedFailed, message: "Cannot confirm the \(noun) on \(name)")
      }
      return
    }
    if state == "missing" {
      self.init(.missing, message: "The \(noun) no longer exists.")
    } else if state == "Booting" {
      self.init(.booting, message: "Booting \(noun)", progress: true)
    } else if isRunning {
      self.init(.live, action: canControl ? .control : .view)
    } else if isPhysical {
      self.init(.disconnected, action: .view)
    } else if building {
      self.init(.booting)
    } else {
      self.init(.shutDown)
    }
  }

  private init(_ phase: Phase, message: String? = nil, progress: Bool = false, action: HeaderAction? = nil) {
    self.phase = phase
    self.message = message
    showsProgress = progress
    headerAction = action
  }
}
