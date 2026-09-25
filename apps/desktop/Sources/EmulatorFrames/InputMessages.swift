import Foundation

// Field numbers and enum values follow MouseEvent, KeyboardEvent and
// EmulatorStatus in the emulator's emulator_controller.proto (sdk/emulator/lib).
enum InputMessages {
  static let macKeyCodeType: UInt64 = 4
  static let keyup: UInt64 = 1
  static let keypress: UInt64 = 2

  /// A MouseEvent on the main display. `pressed` sets the primary button; the
  /// emulator turns it into a single touch on a touchscreen device.
  static func mouse(x: Int, y: Int, pressed: Bool) -> Data {
    message([(1, UInt64(max(x, 0))), (2, UInt64(max(y, 0))), (3, pressed ? 1 : 0)])
  }

  /// A TouchEvent with one finger on the main display, lifted when `pressed`
  /// is false (pressure 0). Unlike a MouseEvent, Android sees a touchscreen
  /// finger, not a mouse or stylus.
  static func touch(x: Int, y: Int, pressed: Bool) -> Data {
    var touch = Data()
    for (field, value) in [(1, UInt64(max(x, 0))), (2, UInt64(max(y, 0))), (4, pressed ? 1 : 0)] where value != 0 {
      ScreenshotMessages.appendVarint(UInt64(field << 3), to: &touch)
      ScreenshotMessages.appendVarint(value, to: &touch)
    }
    var out = Data()
    appendBytes(field: 1, touch, to: &out)
    return out
  }

  /// A KeyboardEvent the emulator types as a key press per character.
  static func text(_ text: String) -> Data {
    var out = Data()
    appendBytes(field: 5, Data(text.utf8), to: &out)
    return out
  }

  /// A KeyboardEvent for a physical key named by its macOS virtual key code,
  /// which the emulator translates to an evdev code.
  static func key(macKeyCode: UInt16, down: Bool) -> Data {
    message([(1, macKeyCodeType), (2, down ? 0 : keyup), (3, UInt64(macKeyCode))])
  }

  /// A KeyboardEvent that presses and releases the key a DOM key name such as
  /// `GoHome` or `Power` names.
  static func namedKey(_ key: String) -> Data {
    var out = message([(2, keypress)])
    appendBytes(field: 4, Data(key.utf8), to: &out)
    return out
  }

  /// The main display's size in pixels, read from `hw.lcd.width` and
  /// `hw.lcd.height` in an EmulatorStatus's hardwareConfig.
  static func displaySize(fromStatus bytes: Data) -> (width: Int, height: Int)? {
    let config = hardwareConfig(fromStatus: bytes)
    guard let width = config["hw.lcd.width"].flatMap({ Int($0) }), let height = config["hw.lcd.height"].flatMap({ Int($0) }),
      width > 0, height > 0
    else { return nil }
    return (width, height)
  }

  /// Whether the emulator has a hardware keyboard (`hw.keyboard` in an
  /// EmulatorStatus's hardwareConfig). Without one it drops every KeyboardEvent.
  static func hasKeyboard(fromStatus bytes: Data) -> Bool {
    hardwareConfig(fromStatus: bytes)["hw.keyboard"] == "true"
  }

  private static func hardwareConfig(fromStatus bytes: Data) -> [String: String] {
    var reader = ProtoReader(bytes)
    var config: [String: String] = [:]
    while let (field, value) = reader.next() {
      guard field == 5, case .bytes(let list) = value else { continue }
      var entries = ProtoReader(list)
      while let (entryField, entryValue) = entries.next() {
        guard entryField == 1, case .bytes(let entry) = entryValue, let (key, value) = pair(entry) else { continue }
        config[key] = value
      }
    }
    return config
  }

  private static func pair(_ bytes: Data) -> (String, String)? {
    var reader = ProtoReader(bytes)
    var key: String?
    var value = ""
    while let (field, item) = reader.next() {
      guard case .bytes(let data) = item else { continue }
      if field == 1 { key = String(decoding: data, as: UTF8.self) }
      if field == 2 { value = String(decoding: data, as: UTF8.self) }
    }
    return key.map { ($0, value) }
  }

  private static func message(_ fields: [(Int, UInt64)]) -> Data {
    var out = Data()
    for (field, value) in fields where value != 0 {
      ScreenshotMessages.appendVarint(UInt64(field << 3), to: &out)
      ScreenshotMessages.appendVarint(value, to: &out)
    }
    return out
  }

  private static func appendBytes(field: Int, _ bytes: Data, to out: inout Data) {
    ScreenshotMessages.appendVarint(UInt64(field << 3 | 2), to: &out)
    ScreenshotMessages.appendVarint(UInt64(bytes.count), to: &out)
    out += bytes
  }
}

/// Maps a fraction of the upright image, origin top-left, to a pixel of the
/// display in its native orientation, which is where the emulator places
/// touches. `rotation` is the image's Rotation.SkinRotation.
func displayPixel(_ point: CGPoint, rotation: Int, displaySize: CGSize) -> (x: Int, y: Int) {
  let native: CGPoint
  switch rotation {
  case 1: native = CGPoint(x: 1 - point.y, y: point.x)
  case 2: native = CGPoint(x: 1 - point.x, y: 1 - point.y)
  case 3: native = CGPoint(x: point.y, y: 1 - point.x)
  default: native = point
  }
  let x = Int((native.x * displaySize.width).rounded(.down))
  let y = Int((native.y * displaySize.height).rounded(.down))
  return (min(max(x, 0), Int(displaySize.width) - 1), min(max(y, 0), Int(displaySize.height) - 1))
}
