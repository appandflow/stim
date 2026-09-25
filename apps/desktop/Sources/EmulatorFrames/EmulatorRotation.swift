import Foundation

/// Turns a running emulator a quarter turn through its gRPC endpoint. It sets
/// the z angle of the ROTATION physical model, as turning a real device would,
/// so the screen follows the app's and the system's rotation rules; with
/// auto-rotate off, Android offers its rotate suggestion instead.
public enum EmulatorRotation {
  /// Returns false when the emulator has no endpoint or refuses the call.
  public static func rotate(serial: String, clockwise: Bool) async -> Bool {
    guard let endpoint = EmulatorDiscovery.endpoint(serial: serial) else { return false }
    let input = EmulatorInput(endpoint: endpoint)
    defer { input.close() }
    guard let current = await call(input, "getPhysicalModel", RotationMessages.rotationTarget) else { return false }
    let angles = RotationMessages.angles(fromPhysicalModel: current)
    let turned = RotationMessages.quarterTurn(z: angles.z, clockwise: clockwise)
    let message = RotationMessages.rotation(x: angles.x, y: angles.y, z: turned)
    return await call(input, "setPhysicalModel", message) != nil
  }

  private static func call(_ input: EmulatorInput, _ method: String, _ message: Data) async -> Data? {
    await withCheckedContinuation { continuation in
      input.call(method, message) { continuation.resume(returning: $0) }
    }
  }
}

// Field numbers follow PhysicalModelValue and ParameterValue in the emulator's
// emulator_controller.proto (sdk/emulator/lib); ROTATION is PhysicalType 1 and
// its values are x, y and z angles in degrees.
enum RotationMessages {
  static let rotationTarget = Data([0x08, 0x01])

  static func rotation(x: Float, y: Float, z: Float) -> Data {
    var floats = Data()
    for value in [x, y, z] { withUnsafeBytes(of: value.bitPattern.littleEndian) { floats += $0 } }
    let parameter = Data([0x0a, UInt8(floats.count)]) + floats
    return rotationTarget + Data([0x1a, UInt8(parameter.count)]) + parameter
  }

  /// The angles in a PhysicalModelValue; proto3 omits an all-zero value.
  static func angles(fromPhysicalModel bytes: Data) -> (x: Float, y: Float, z: Float) {
    var reader = ProtoReader(bytes)
    while let (field, value) = reader.next() {
      guard field == 3, case .bytes(let parameter) = value else { continue }
      var values = ProtoReader(parameter)
      while let (valueField, packed) = values.next() {
        guard valueField == 1, case .bytes(let data) = packed, data.count >= 12 else { continue }
        let floats = stride(from: 0, to: 12, by: 4).map { offset in
          Float(bitPattern: data.dropFirst(offset).prefix(4).reversed().reduce(0) { $0 << 8 | UInt32($1) })
        }
        return (floats[0], floats[1], floats[2])
      }
    }
    return (0, 0, 0)
  }

  /// The next z angle, in (-180, 180]; a positive angle turns the device counterclockwise.
  static func quarterTurn(z: Float, clockwise: Bool) -> Float {
    let quarter = (z / 90).rounded() * 90
    var next = quarter + (clockwise ? -90 : 90)
    if next > 180 { next -= 360 }
    if next <= -180 { next += 360 }
    return next
  }
}
