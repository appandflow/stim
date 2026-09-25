import Foundation

/// The posture of a foldable emulator, as the emulator's Posture.PostureValue
/// numbers it.
public enum EmulatorPosture: Int, CaseIterable, Sendable {
  case closed = 1
  case halfOpened = 2
  case opened = 3
  case flipped = 4
  case tent = 5

  public var label: String {
    switch self {
    case .closed: return "Folded"
    case .halfOpened: return "Half open"
    case .opened: return "Unfolded"
    case .flipped: return "Flipped"
    case .tent: return "Tent"
    }
  }

  /// The emulator's current posture; nil for an emulator without a hinge, or
  /// one whose endpoint cannot be reached.
  public static func current(serial: String) async -> EmulatorPosture? {
    guard let endpoint = EmulatorDiscovery.endpoint(serial: serial) else { return nil }
    let input = EmulatorInput(endpoint: endpoint)
    defer { input.close() }
    return await input.call("getPhysicalModel", PostureMessages.postureTarget).flatMap(PostureMessages.posture)
  }

  /// Moves the hinge to this posture. Returns false when the emulator has no
  /// endpoint or refuses the call.
  public func apply(serial: String) async -> Bool {
    guard let endpoint = EmulatorDiscovery.endpoint(serial: serial) else { return false }
    let input = EmulatorInput(endpoint: endpoint)
    defer { input.close() }
    return await input.call("setPosture", PostureMessages.setPosture(self)) != nil
  }
}

// Field numbers follow PhysicalModelValue, ParameterValue and Posture in the
// emulator's emulator_controller.proto (sdk/emulator/lib); POSTURE is
// PhysicalType 16, and its single value is the PostureValue as a float.
enum PostureMessages {
  static let postureTarget = Data([0x08, 0x10])

  static func setPosture(_ posture: EmulatorPosture) -> Data {
    Data([0x18, UInt8(posture.rawValue)])
  }

  static func posture(fromPhysicalModel bytes: Data) -> EmulatorPosture? {
    var reader = ProtoReader(bytes)
    while let (field, value) = reader.next() {
      if field == 2, case .varint(let status) = value, status != 0 { return nil }
      guard field == 3, case .bytes(let parameter) = value else { continue }
      var values = ProtoReader(parameter)
      while let (valueField, packed) = values.next() {
        guard valueField == 1, case .bytes(let data) = packed, data.count >= 4 else { continue }
        let raw = Float(bitPattern: data.prefix(4).reversed().reduce(0) { $0 << 8 | UInt32($1) })
        return EmulatorPosture(rawValue: Int(raw.rounded()))
      }
    }
    return nil
  }
}

extension EmulatorInput {
  func call(_ method: String, _ message: Data) async -> Data? {
    await withCheckedContinuation { continuation in
      call(method, message) { continuation.resume(returning: $0) }
    }
  }
}
