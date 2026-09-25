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

  /// Desktop's name for the device: a named slot keeps its name, and the default slot takes the device's own name.
  /// `stim status` does not report an emulator's hardware profile, so an owned AVD is "Android emulator".
  public var label: String {
    guard slot == DeviceRef.defaultSlot else { return slot }
    switch self {
    case .ios: return iosModel.name
    case .android(_, let d): return d.owned ? "Android emulator" : d.name
    case .remote(let d): return "\(d.backend.uppercased()) \(model)"
    }
  }

  /// `label`, followed by the device's kind when another device in `devices` has the same label.
  public func label(among devices: [DeviceRef]) -> String {
    let own = label
    guard devices.contains(where: { $0.id != id && $0.label == own }) else { return own }
    switch self {
    case .ios: return "\(own) \u{00B7} iOS"
    case .android: return "\(own) \u{00B7} Android"
    case .remote: return "\(own) \u{00B7} remote"
    }
  }

  /// What `label` leaves out: the model for a named slot, the runtime for a default-slot simulator.
  public var detail: String? {
    if slot != DeviceRef.defaultSlot { return model }
    switch self {
    case .ios: return iosModel.runtime.map { "iOS \($0)" }
    case .android(_, let d): return d.owned ? d.name : nil
    case .remote: return nil
    }
  }

  private var iosModel: (name: String, runtime: String?) {
    let model = self.model
    guard let space = model.lastIndex(of: " ") else { return (model, nil) }
    let runtime = model[model.index(after: space)...]
    guard runtime.first?.isNumber == true, runtime.allSatisfy({ $0.isNumber || $0 == "." }) else { return (model, nil) }
    return (String(model[..<space]), String(runtime))
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
