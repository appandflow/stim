import Foundation

/// What a device tile says about its device: the header action it offers, a status line, and whether it is still
/// working. Shut down, booting, live, hosted starting, hosted failed and missing devices each read differently.
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
    let noun = device.platform == "android" ? "emulator" : "simulator"
    if let machine = device.hostedMachine {
      let name = machineName(machine)
      switch device.state {
      case "ready": self.init(.live, action: canControl ? .control : .view)
      case "stopped": self.init(.shutDown)
      case "unverified" where building:
        self.init(.hostedStarting, message: "Starting \(noun) on \(name)", progress: true)
      default: self.init(.hostedFailed, message: "Cannot confirm the \(noun) on \(name)")
      }
      return
    }
    if device.state == "missing" {
      self.init(.missing, message: "The \(noun) no longer exists.")
    } else if device.state == "Booting" {
      self.init(.booting, message: "Booting \(noun)", progress: true)
    } else if device.isRunning {
      self.init(.live, action: canControl ? .control : .view)
    } else if device.isPhysical {
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
