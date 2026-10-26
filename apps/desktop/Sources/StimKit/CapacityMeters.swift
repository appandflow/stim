import Foundation

extension CapacityLoad {
  /// The load as the toolbar and the machine page print it, such as "2.4/core".
  public var text: String { "\(formatLoad(loadPerCore))/core" }

  public var tone: Tone {
    switch state {
    case .free, .other: return .normal
    case .busy: return .caution
    case .holding: return .error
    }
  }

  /// What the state means for new work on this Mac.
  public var explanation: String {
    switch state {
    case .free: return "Under \(formatLoad(busyAt)) per core."
    case .busy: return "At or over \(formatLoad(busyAt)) per core, so placement prefers another machine."
    case .holding:
      return "New local native work waits"
        + (limit.map { " until the load is under \(formatLoad($0)) per core." } ?? ".")
    case .other: return "Stim reported a load state this version does not know."
    }
  }
}

public struct CapacityMeter: Hashable, Sendable {
  public enum Kind: Hashable, Sendable { case devices, builds }

  public var kind: Kind
  public var label: String
  /// The slots in use over the cap, such as "6 / 6", or "? / 6" when `stim` could not count.
  public var value: String
  public var isFull: Bool
  /// Why the count is unknown.
  public var reason: String?
}

extension Capacity {
  /// The device and build slot meters; each is present only while its cap is set.
  public var meters: [CapacityMeter] {
    var meters: [CapacityMeter] = []
    if let devices {
      meters.append(
        CapacityMeter(
          kind: .devices, label: "Devices", value: "\(devices.inUse.map(String.init) ?? "?") / \(devices.max)",
          isFull: devices.inUse.map { $0 >= devices.max } ?? false, reason: devices.inUse == nil ? devices.unknown : nil))
    }
    if let builds {
      meters.append(
        CapacityMeter(
          kind: .builds, label: "Builds", value: "\(builds.inUse) / \(builds.max)", isFull: builds.inUse >= builds.max,
          reason: nil))
    }
    return meters
  }
}

/// One device holding a device slot.
public struct DeviceHolderRow: Hashable, Identifiable, Sendable {
  public var id: String
  public var label: String
  public var platform: String
  public var slot: String?
  /// "Booting", or how long the device has been idle; nil when it was used in the last 10 minutes or is not known.
  public var detail: String?
  /// `stim stop --slot <slot>` in the holder's workspace; nil for a device no workspace records.
  public var stop: StimCommand?
}

public enum BuildHolderOwner: Hashable, Sendable {
  case workspace(String)
  case client(String)
  case unresolved
}

extension BuildSlotHolder {
  public var owner: BuildHolderOwner {
    if let workspace { return .workspace(workspace) }
    if let client { return .client(client) }
    return .unresolved
  }
}

extension DeviceSlots {
  /// The holders with the idle time of the device each workspace records for its slot.
  public func rows(in environments: [Workspace], now: Date = Date()) -> [DeviceHolderRow] {
    holders.enumerated().map { index, holder in
      let slot = holder.slot ?? DeviceRef.defaultSlot
      let device = holder.workspace.flatMap { path in
        environments.first { $0.path == path }?.devices.first { $0.platform == holder.platform && $0.slot == slot }
      }
      let screenChangedAt = device?.activityKey.flatMap { ScreenActivity.shared.lastChange($0) }
      let idle = ActivityBadge(device?.activity, screenChangedAt: screenChangedAt, now: now).map(\.text)
      return DeviceHolderRow(
        id: "\(index):\(holder.platform):\(holder.workspace ?? ""):\(holder.slot ?? ""):\(holder.label)",
        label: holder.label, platform: holder.platform, slot: holder.slot,
        detail: holder.booting == true ? "Booting" : idle,
        stop: holder.workspace.flatMap { workspace in
          holder.slot.map { StimCommand(["stop", "--slot", $0], cwd: workspace) }
        })
    }
  }
}
