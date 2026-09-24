public enum DeviceRef: Hashable, Identifiable, Sendable {
  case ios(slot: String, IosDevice)
  case android(slot: String, AndroidDevice)

  public static let defaultSlot = "default"

  public var id: String {
    switch self {
    case .ios(_, let d): return "ios:\(d.udid)"
    case .android(let slot, let d): return "android:\(slot):\(d.name)"
    }
  }

  public var slot: String {
    switch self {
    case .ios(let s, _), .android(let s, _): return s
    }
  }

  public var state: String {
    switch self {
    case .ios(_, let d): return d.state
    case .android(_, let d): return d.state
    }
  }

  /// `Booted` comes from simctl; `detected` is Stim's Android runtime state for an AVD adb can see.
  public var isRunning: Bool {
    switch self {
    case .ios(_, let d): return d.state == "Booted"
    case .android(_, let d): return d.state == "detected"
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
    }
  }

  public var formFactor: FormFactor {
    switch self {
    case .ios(_, let d):
      if d.name.contains("iPad") { return .tablet }
      if d.name.contains("Duo") { return .dual }
      return .phone
    case .android:
      return .phone
    }
  }
}

public enum FormFactor: Sendable {
  case phone
  case tablet
  case dual
}
