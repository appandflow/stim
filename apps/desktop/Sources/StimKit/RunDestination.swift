import Foundation

public enum RunDestination: Hashable, Sendable {
  case thisMac
  case auto
  case machine(String)

  public init(saved: String, approvedMachines: [String]) {
    if saved == "auto" {
      self = .auto
    } else if approvedMachines.contains(saved) {
      self = .machine(saved)
    } else {
      self = .thisMac
    }
  }

  public var saved: String {
    switch self {
    case .thisMac: return ""
    case .auto: return "auto"
    case .machine(let machine): return machine
    }
  }

  public var title: String {
    switch self {
    case .thisMac: return "This Mac"
    case .auto: return "Auto"
    case .machine(let machine): return machineName(machine)
    }
  }

  public var arguments: [String] {
    self == .thisMac ? [] : ["--remote", saved]
  }
}

extension Workspace {
  public func hostedMachine(platform: String, slot: String = DeviceRef.defaultSlot) -> String? {
    devices.first { $0.platform == platform && $0.slot == slot }?.hostedMachine
  }

  public func runCommand(platform: String, destination: RunDestination = .thisMac) -> StimCommand {
    let remote = hostedMachine(platform: platform).map { RunDestination.machine($0) } ?? destination
    let arguments = [platform] + (["ios", "android"].contains(platform) ? remote.arguments : [])
    return StimCommand(arguments, cwd: path)
  }
}
