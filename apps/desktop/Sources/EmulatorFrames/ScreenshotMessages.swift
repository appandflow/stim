import Foundation

/// One RGBA8888 frame of an emulator display.
public struct EmulatorFrame: Sendable {
  public var width: Int
  public var height: Int
  public var rgba: Data
}

// Field numbers follow ImageFormat and Image in the emulator's
// emulator_controller.proto (sdk/emulator/lib).
enum ScreenshotMessages {
  static let rgba8888: UInt64 = 1

  static func imageFormat(width: Int, height: Int) -> Data {
    var out = Data()
    for (field, value) in [(1, rgba8888), (3, UInt64(width)), (4, UInt64(height))] {
      appendVarint(UInt64(field << 3), to: &out)
      appendVarint(value, to: &out)
    }
    return out
  }

  static func frame(fromImage bytes: Data) -> EmulatorFrame? {
    var reader = ProtoReader(bytes)
    var size: (width: Int, height: Int)?
    var image: Data?
    while let (field, value) = reader.next() {
      switch (field, value) {
      case (1, .bytes(let nested)): size = rgbaSize(nested)
      case (4, .bytes(let data)): image = data
      default: break
      }
    }
    guard let size, let image, size.width > 0, size.height > 0,
      image.count == size.width * size.height * 4
    else { return nil }
    return EmulatorFrame(width: size.width, height: size.height, rgba: image)
  }

  private static func rgbaSize(_ bytes: Data) -> (width: Int, height: Int)? {
    var reader = ProtoReader(bytes)
    var format: UInt64 = 0
    var width = 0
    var height = 0
    while let (field, value) = reader.next() {
      switch (field, value) {
      case (1, .varint(let v)): format = v
      case (3, .varint(let v)): width = Int(v)
      case (4, .varint(let v)): height = Int(v)
      default: break
      }
    }
    guard format == rgba8888 else { return nil }
    return (width, height)
  }

  static func appendVarint(_ value: UInt64, to out: inout Data) {
    var v = value
    while v >= 0x80 {
      out.append(UInt8(v & 0x7f) | 0x80)
      v >>= 7
    }
    out.append(UInt8(v))
  }
}

struct ProtoReader {
  enum Value {
    case varint(UInt64)
    case bytes(Data)
    case fixed
  }

  private let data: Data
  private var index: Data.Index

  init(_ data: Data) {
    self.data = data
    index = data.startIndex
  }

  mutating func next() -> (Int, Value)? {
    guard index < data.endIndex, let key = varint() else { return nil }
    let field = Int(key >> 3)
    switch key & 7 {
    case 0:
      guard let v = varint() else { return nil }
      return (field, .varint(v))
    case 1, 5:
      let size = key & 7 == 1 ? 8 : 4
      guard data.endIndex - index >= size else { return nil }
      index += size
      return (field, .fixed)
    case 2:
      guard let length = varint(), UInt64(data.endIndex - index) >= length else { return nil }
      let end = index + Int(length)
      defer { index = end }
      return (field, .bytes(data[index..<end]))
    default:
      return nil
    }
  }

  private mutating func varint() -> UInt64? {
    var result: UInt64 = 0
    var shift: UInt64 = 0
    while index < data.endIndex, shift < 64 {
      let byte = data[index]
      index += 1
      result |= UInt64(byte & 0x7f) << shift
      if byte < 0x80 { return result }
      shift += 7
    }
    return nil
  }
}
