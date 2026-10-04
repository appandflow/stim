import AppKit

struct SimulatorKeyboardModifiers {
  private var pressed: Set<UInt16> = []
  private var shiftCode: UInt16 = 56

  mutating func change(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> [(code: UInt16, down: Bool)] {
    guard let flag = modifierFlag(keyCode: keyCode) else { return [] }
    if flag == .shift { shiftCode = keyCode }
    var changes: [(code: UInt16, down: Bool)] = []
    let shifting = flags.contains(.shift) && !flags.contains(.option)
    let heldShift = pressed.filter { modifierFlag(keyCode: $0) == .shift }
    if shifting {
      if heldShift.isEmpty {
        pressed.insert(shiftCode)
        changes.append((shiftCode, true))
      }
    } else {
      for code in heldShift {
        pressed.remove(code)
        changes.append((code, false))
      }
    }
    guard flag != .option, flag != .shift else { return changes }
    let down = flags.contains(flag)
    if down { pressed.insert(keyCode) } else { pressed.remove(keyCode) }
    changes.append((keyCode, down))
    return changes
  }

  mutating func release() -> Set<UInt16> {
    defer { pressed = [] }
    return pressed
  }
}

private func modifierFlag(keyCode: UInt16) -> NSEvent.ModifierFlags? {
  switch keyCode {
  case 56, 60: return .shift
  case 59, 62: return .control
  case 58, 61: return .option
  case 55, 54: return .command
  case 57: return .capsLock
  default: return nil
  }
}
