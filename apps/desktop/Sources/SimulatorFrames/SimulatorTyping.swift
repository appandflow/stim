import Foundation

// macOS virtual key codes of a US keyboard, which SimulatorKit's
// hidUsageForCGKeyCode turns into HID usages and the emulator turns into evdev
// keys; shifted characters also hold Shift (0x38).
let keyCodes: [Character: (code: UInt16, shift: Bool)] = {
  var map: [Character: (UInt16, Bool)] = [:]
  let plain: [(String, UInt16)] = [
    ("a", 0x00), ("s", 0x01), ("d", 0x02), ("f", 0x03), ("h", 0x04), ("g", 0x05), ("z", 0x06), ("x", 0x07),
    ("c", 0x08), ("v", 0x09), ("b", 0x0B), ("q", 0x0C), ("w", 0x0D), ("e", 0x0E), ("r", 0x0F), ("y", 0x10),
    ("t", 0x11), ("1", 0x12), ("2", 0x13), ("3", 0x14), ("4", 0x15), ("6", 0x16), ("5", 0x17), ("=", 0x18),
    ("9", 0x19), ("7", 0x1A), ("-", 0x1B), ("8", 0x1C), ("0", 0x1D), ("]", 0x1E), ("o", 0x1F), ("u", 0x20),
    ("[", 0x21), ("i", 0x22), ("p", 0x23), ("l", 0x25), ("j", 0x26), ("'", 0x27), ("k", 0x28), (";", 0x29),
    ("\\", 0x2A), (",", 0x2B), ("/", 0x2C), ("n", 0x2D), ("m", 0x2E), (".", 0x2F), ("`", 0x32), (" ", 0x31),
    ("\n", 0x24), ("\t", 0x30), ("\u{8}", 0x33),
  ]
  for (text, code) in plain { map[Character(text)] = (code, false) }
  for letter in "abcdefghijklmnopqrstuvwxyz" { map[Character(letter.uppercased())] = (map[letter]!.0, true) }
  let shifted: [(Character, Character)] = [
    ("!", "1"), ("@", "2"), ("#", "3"), ("$", "4"), ("%", "5"), ("^", "6"), ("&", "7"), ("*", "8"), ("(", "9"),
    (")", "0"), ("_", "-"), ("+", "="), ("{", "["), ("}", "]"), ("|", "\\"), (":", ";"), ("\"", "'"), ("<", ","),
    (">", "."), ("?", "/"), ("~", "`"),
  ]
  for (character, base) in shifted { map[character] = (map[base]!.0, true) }
  return map
}()

/// What a paste into an iOS simulator did. `typed` means the text went into the focused field as key presses, so iOS
/// showed no paste prompt; `pasted` means Command-V, which can leave a paste suggestion to tap.
public enum SimulatorPasteOutcome: Equatable, Sendable {
  case typed
  case pasted
  case failed
}

enum SimulatorTyping {
  /// The most UTF-8 bytes typed; longer text is pasted. Equals `MAX_CLIPBOARD_BYTES` in `packages/core/protocol.ts`.
  static let maxBytes = 8192

  static func keys(for text: String) -> [(code: UInt16, shift: Bool)]? {
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
    guard !normalized.isEmpty, normalized.utf8.count <= maxBytes else { return nil }
    var keys: [(code: UInt16, shift: Bool)] = []
    for character in normalized {
      guard character != "\u{8}", let key = keyCodes[character] else { return nil }
      keys.append(key)
    }
    return keys
  }
}
