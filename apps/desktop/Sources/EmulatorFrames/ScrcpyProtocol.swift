import Foundation

/// The scrcpy server (Apache-2.0) that streams a physical Android device's screen as H.264 over an adb
/// socket and injects input from a control socket. Its client and server must be the same version: the
/// server refuses any other `version` argument, and the wire format changes between releases.
enum Scrcpy {
  static let version = "4.1"
  /// The sha256 of `scrcpy-server-v4.1` in the release's SHA256SUMS.txt.
  static let serverSha256 = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae"
  static let maxSize = 2048

  /// `app_process` arguments after the class name. `cleanup=true` forks a process that deletes the pushed
  /// jar as soon as the server starts; `power_on=false` and the absent `show_touches`/`stay_awake` keep the
  /// device's settings and screen state untouched.
  static func serverArguments(scid: String) -> [String] {
    [
      version, "scid=\(scid)", "log_level=warn", "tunnel_forward=true", "audio=false", "control=true",
      "video_codec=h264", "max_size=\(maxSize)", "max_fps=60", "clipboard_autosync=false", "power_on=false",
      "cleanup=true", "send_device_meta=false",
    ]
  }

  enum KeyAction: UInt8 {
    case down = 0
    case up = 1
  }

  enum TouchAction: UInt8 {
    case down = 0
    case up = 1
    case move = 2
  }

  /// Android `KeyEvent` codes for the buttons and the control characters `input.text` takes.
  static let keycodes: [String: Int32] = [
    "home": 3, "back": 4, "lock": 26, "app-switch": 187, "\n": 66, "\t": 61, "\u{8}": 67,
  ]

  /// `POINTER_ID_GENERIC_FINGER` in scrcpy's Controller: a finger touch, not a mouse.
  static let fingerPointer: Int64 = -2

  static func keycode(_ action: KeyAction, _ keycode: Int32) -> Data {
    var data = Data([0, action.rawValue])
    append(UInt32(bitPattern: keycode), to: &data)
    append(UInt32(0), to: &data)
    append(UInt32(0), to: &data)
    return data
  }

  static func text(_ text: String) -> Data {
    let bytes = Data(text.utf8)
    var data = Data([1])
    append(UInt32(bytes.count), to: &data)
    return data + bytes
  }

  /// `x` and `y` are pixels in the video frame of size `width` by `height`; the server ignores a touch
  /// whose frame size is not its current one, such as one sent across a rotation.
  static func touch(
    _ action: TouchAction, pointer: Int64 = fingerPointer, x: Int32, y: Int32, width: UInt16, height: UInt16
  ) -> Data {
    var data = Data([2, action.rawValue])
    append(UInt64(bitPattern: pointer), to: &data)
    append(UInt32(bitPattern: x), to: &data)
    append(UInt32(bitPattern: y), to: &data)
    append(width, to: &data)
    append(height, to: &data)
    append(action == .up ? UInt16(0) : UInt16(0xffff), to: &data)
    append(UInt32(0), to: &data)
    append(UInt32(0), to: &data)
    return data
  }

  /// Asks the server to restart its encoder, which starts the stream again with a config packet and a keyframe.
  static let resetVideo = Data([17])

  private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    withUnsafeBytes(of: value.bigEndian) { data.append(contentsOf: $0) }
  }
}

/// One item of the video socket after the dummy byte: the codec, a capture session with the frame size
/// (a new one after each rotation), or a packet of Annex-B H.264. A config packet carries the SPS and PPS.
enum ScrcpyVideoEvent: Equatable {
  case codec(UInt32)
  case session(width: Int, height: Int)
  case packet(config: Bool, keyframe: Bool, data: Data)
}

/// Splits the bytes of the video socket into events, whatever the chunking of the reads.
struct ScrcpyVideoDemuxer {
  static let h264: UInt32 = 0x6832_3634
  private var buffer = Data()
  private var codecRead = false

  mutating func push(_ chunk: Data) throws -> [ScrcpyVideoEvent] {
    buffer += chunk
    var events: [ScrcpyVideoEvent] = []
    while true {
      let start = buffer.startIndex
      if !codecRead {
        guard buffer.count >= 4 else { break }
        events.append(.codec(read32(start)))
        buffer.removeFirst(4)
        codecRead = true
        continue
      }
      guard buffer.count >= 12 else { break }
      if buffer[start] & 0x80 != 0 {
        events.append(.session(width: Int(read32(start + 4)), height: Int(read32(start + 8))))
        buffer.removeFirst(12)
        continue
      }
      let length = Int(read32(start + 8))
      guard length <= 16 * 1024 * 1024 else { throw ScrcpyError.malformed("a \(length)-byte video packet") }
      guard buffer.count >= 12 + length else { break }
      let flags = buffer[start]
      let payload = Data(buffer[(start + 12)..<(start + 12 + length)])
      events.append(.packet(config: flags & 0x40 != 0, keyframe: flags & 0x20 != 0, data: payload))
      buffer.removeFirst(12 + length)
    }
    return events
  }

  private func read32(_ at: Int) -> UInt32 {
    buffer[at..<(at + 4)].reduce(0) { $0 << 8 | UInt32($1) }
  }
}

enum ScrcpyError: Error, CustomStringConvertible {
  case malformed(String)

  var description: String {
    switch self {
    case .malformed(let what): return "The scrcpy server sent \(what)."
    }
  }
}

enum AnnexB {
  /// The NAL units of an Annex-B byte stream, without their start codes.
  static func units(_ data: Data) -> [Data] {
    let bytes = [UInt8](data)
    var starts: [(code: Int, payload: Int)] = []
    var index = 0
    while index + 2 < bytes.count {
      if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 {
        let code = index > 0 && bytes[index - 1] == 0 ? index - 1 : index
        starts.append((code, index + 3))
        index += 3
      } else {
        index += 1
      }
    }
    return starts.indices.map { position in
      let end = position + 1 < starts.count ? starts[position + 1].code : bytes.count
      return Data(bytes[starts[position].payload..<end])
    }
  }

  /// The same units with 4-byte big-endian lengths, as a `CMSampleBuffer` of `avc1` takes them.
  static func lengthPrefixed(_ units: [Data]) -> Data {
    var out = Data()
    for unit in units {
      withUnsafeBytes(of: UInt32(unit.count).bigEndian) { out.append(contentsOf: $0) }
      out += unit
    }
    return out
  }
}
