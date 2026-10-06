import Carbon
import Foundation

public struct KeyboardLayoutMap: Sendable {
  private var layers: [Bool: [Character: UInt16]] = [:]

  public init(translate: (UInt16, Bool) -> String?) {
    for command in [false, true] {
      var codes: [Character: UInt16] = [:]
      for keyCode: UInt16 in 0...50 {
        guard let text = translate(keyCode, command), text.count == 1, let character = text.first,
          "abcdefghijklmnopqrstuvwxyz0123456789".contains(character), codes[character] == nil
        else { continue }
        codes[character] = keyCode
      }
      layers[command] = codes
    }
  }

  public init(layoutData: CFData) {
    let layout = UnsafeRawPointer(CFDataGetBytePtr(layoutData)!).assumingMemoryBound(to: UCKeyboardLayout.self)
    let keyboardType = UInt32(LMGetKbdType())
    self.init { keyCode, command in
      var deadKeyState: UInt32 = 0
      var length = 0
      var output = [UniChar](repeating: 0, count: 255)
      let status = UCKeyTranslate(
        layout, keyCode, UInt16(kUCKeyActionDown), command ? UInt32(cmdKey >> 8) : 0,
        keyboardType, 0, &deadKeyState, output.count, &length, &output)
      guard status == noErr, deadKeyState == 0, length > 0 else { return nil }
      return String(utf16CodeUnits: output, count: length)
    }
  }

  public func keyCode(for character: Character, command: Bool) -> UInt16? {
    layers[command]?[character]
  }
}

public final class KeyboardLayoutCache: @unchecked Sendable {
  private let lock = NSLock()
  private var maps: [String: KeyboardLayoutMap] = [:]

  public init() {}

  public func current() -> (id: String, map: KeyboardLayoutMap)? {
    // Apple TextInputSources requires main-thread access.
    precondition(Thread.isMainThread)
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let idProperty = TISGetInputSourceProperty(source, kTISPropertyInputSourceID),
      let dataProperty = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    let id = Unmanaged<CFString>.fromOpaque(idProperty).takeUnretainedValue() as String
    let data = Unmanaged<CFData>.fromOpaque(dataProperty).takeUnretainedValue()
    guard CFDataGetLength(data) > 0 else { return nil }
    lock.lock()
    defer { lock.unlock() }
    if let map = maps[id] { return (id, map) }
    let map = KeyboardLayoutMap(layoutData: data)
    maps[id] = map
    return (id, map)
  }
}
