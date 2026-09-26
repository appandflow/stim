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

  /// The model and runtime from an owned simulator name, `stim-<label> (<model> <runtime>)`. A name collision makes
  /// Stim append a disambiguating suffix after the closing paren, so the match stops at the paren that closes the
  /// one it opened rather than at the name's own end. Only tried on an owned name: Apple's own simulator names carry
  /// parens too ("iPhone SE (3rd generation)", "iPad Pro 11-inch (M4)"), which are not this format at all.
  public var model: String {
    switch self {
    case .ios(_, let d):
      return d.owned ? (DeviceRef.parenthesizedModel(in: d.name) ?? d.name) : d.name
    case .android(_, let d):
      return d.name
    case .remote(let d):
      return d.platform == "android" ? "Android" : "iOS"
    }
  }

  private static func parenthesizedModel(in name: String) -> String? {
    guard let open = name.firstIndex(of: "(") else { return nil }
    var depth = 0
    var index = open
    while index < name.endIndex {
      if name[index] == "(" { depth += 1 } else if name[index] == ")" {
        depth -= 1
        if depth == 0 { return String(name[name.index(after: open)..<index]) }
      }
      index = name.index(after: index)
    }
    return nil
  }

  /// A readable form of an `avdmanager` hardware profile id ("pixel_fold" -> "Pixel Fold"). Does not special-case an
  /// abbreviation such as "xl", so "pixel_9_pro_xl" reads "Pixel 9 Pro Xl" rather than Google's own "Pixel 9 Pro XL".
  private static func readableDeviceProfile(_ profile: String) -> String {
    guard profile.contains("_") else { return profile }
    return profile.split(separator: "_").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
  }

  /// Desktop's name for the device: a named slot keeps its name, and the default slot takes the device's own name.
  public var label: String {
    guard slot == DeviceRef.defaultSlot else { return slot }
    switch self {
    case .ios: return iosModel.name
    case .android(_, let d):
      guard d.owned else { return d.name }
      return d.deviceProfile.map(DeviceRef.readableDeviceProfile) ?? "Android emulator"
    case .remote(let d): return "\(d.backend.uppercased()) \(model)"
    }
  }

  /// `label`, followed by whatever tells it apart from another device in `devices` that shares it: the runtime when
  /// every device sharing the label is an iOS simulator (a model can recur across workspaces on a different iOS
  /// version), otherwise the platform.
  public func label(among devices: [DeviceRef]) -> String {
    let own = label
    let others = devices.filter { $0.id != id && $0.label == own }
    guard !others.isEmpty else { return own }
    if case .ios = self, let runtime = iosModel.runtime, others.allSatisfy({ if case .ios = $0 { return true } else { return false } }) {
      return "\(own) \u{00B7} \(runtime)"
    }
    switch self {
    case .ios: return "\(own) \u{00B7} iOS"
    case .android: return "\(own) \u{00B7} Android"
    case .remote: return "\(own) \u{00B7} remote"
    }
  }

  /// What `label` leaves out: the model for a named slot, the runtime for a default-slot simulator, the AVD name for
  /// a default-slot owned emulator.
  public var detail: String? {
    if slot != DeviceRef.defaultSlot { return model }
    switch self {
    case .ios: return iosModel.runtime.map { "iOS \($0)" }
    case .android(_, let d): return d.owned ? d.name : nil
    case .remote: return nil
    }
  }

  /// Only splits off a trailing numeric runtime from a name Stim itself formatted as `<model> <runtime>` inside
  /// parens -- an unowned simulator can be legitimately named e.g. "iPhone 16", which is not `<model> <runtime>`.
  private var iosModel: (name: String, runtime: String?) {
    guard case .ios(_, let d) = self, d.owned, let parsed = DeviceRef.parenthesizedModel(in: d.name) else {
      return (model, nil)
    }
    guard let space = parsed.lastIndex(of: " ") else { return (parsed, nil) }
    let runtime = parsed[parsed.index(after: space)...]
    guard runtime.first?.isNumber == true, runtime.allSatisfy({ $0.isNumber || $0 == "." }) else { return (parsed, nil) }
    return (String(parsed[..<space]), String(runtime))
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
