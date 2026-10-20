import Foundation

enum NalType {
  static let idr: UInt8 = 5
  static let sps: UInt8 = 7
  static let pps: UInt8 = 8
}

enum AnnexB {
  /// The NAL units of an Annex-B access unit, without their start codes.
  static func units(_ bytes: UnsafeRawBufferPointer) -> [UnsafeRawBufferPointer] {
    let count = bytes.count
    var units: [UnsafeRawBufferPointer] = []
    var start = -1
    var index = 0
    while index + 3 <= count {
      if bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 {
        if start >= 0 {
          var end = index
          if end > start, bytes[end - 1] == 0 { end -= 1 }
          units.append(UnsafeRawBufferPointer(rebasing: bytes[start..<end]))
        }
        index += 3
        start = index
      } else {
        index += 1
      }
    }
    if start >= 0, start < count {
      units.append(UnsafeRawBufferPointer(rebasing: bytes[start..<count]))
    }
    return units.filter { !$0.isEmpty }
  }
}
