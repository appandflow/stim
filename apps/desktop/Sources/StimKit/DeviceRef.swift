public enum DeviceRef: Hashable, Identifiable, Sendable {
  case ios(slot: String, IosDevice)
  case android(slot: String, AndroidDevice)
  case remote(RemoteDevice)

  public static let defaultSlot = "default"

  public var id: String {
    switch self {
    case .ios(_, let d): return "ios:\(d.udid)"
    case .android(let slot, let d): return "android:\(slot):\(d.name)"
    case .remote(let d): return "remote:\(d.sessionId)"
    }
  }

  public var slot: String {
    switch self {
    case .ios(let s, _), .android(let s, _): return s
    case .remote: return DeviceRef.defaultSlot
    }
  }

  public var platform: String {
    switch self {
    case .ios: return "ios"
    case .android: return "android"
    case .remote(let d): return d.platform ?? ""
    }
  }

  public var state: String {
    switch self {
    case .ios(_, let d): return d.state
    case .android(_, let d): return d.state
    case .remote(let d): return d.state
    }
  }

  public var activity: DeviceActivity? {
    switch self {
    case .ios(_, let d): return d.activity
    case .android(_, let d): return d.activity
    case .remote: return nil
    }
  }

  /// The key `ScreenActivity` records screen changes under: the simulator UDID or the emulator serial.
  public var activityKey: String? {
    switch self {
    case .ios(_, let d): return d.udid
    case .android(_, let d): return d.serial
    case .remote: return nil
    }
  }

  /// `Booted` comes from simctl; `detected` is Stim's Android runtime state for an AVD adb can see.
  /// A recorded remote session counts as running: `stim status` does not ask the backend.
  public var isRunning: Bool {
    switch self {
    case .ios(_, let d): return d.state == "Booted"
    case .android(_, let d): return d.state == "detected"
    case .remote: return true
    }
  }

  /// The model and runtime from an owned simulator name, `stim-<label> (<model> <runtime>)`.
  public var model: String {
    switch self {
    case .ios(_, let d):
      guard let open = d.name.firstIndex(of: "("), d.name.hasSuffix(")") else { return d.name }
      return String(d.name[d.name.index(after: open)..<d.name.index(before: d.name.endIndex)])
    case .android(_, let d):
      return d.name
    case .remote(let d):
      return d.platform == "android" ? "Android" : "iOS"
    }
  }

  public var formFactor: FormFactor {
    switch self {
    case .ios(_, let d):
      if d.name.contains("iPad") { return .tablet }
      if d.name.contains("Duo") { return .dual }
      return .phone
    case .android, .remote:
      return .phone
    }
  }
}

public enum FormFactor: Sendable {
  case phone
  case tablet
  case dual
}
