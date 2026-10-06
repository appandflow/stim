import Carbon
import Foundation
import Testing

@testable import StimKit

@Suite struct KeyboardLayoutMapTests {
  private let us: [UInt16: String] = [
    0: "a", 11: "b", 8: "c", 2: "d", 14: "e", 3: "f", 5: "g", 4: "h", 34: "i",
    38: "j", 40: "k", 37: "l", 46: "m", 45: "n", 31: "o", 35: "p", 12: "q",
    15: "r", 1: "s", 17: "t", 32: "u", 9: "v", 13: "w", 7: "x", 16: "y", 6: "z",
    29: "0", 18: "1", 19: "2", 20: "3", 21: "4", 23: "5", 22: "6", 26: "7", 28: "8", 25: "9",
  ]
  private let dvorak: [UInt16: String] = [
    0: "a", 45: "b", 34: "c", 4: "d", 2: "e", 16: "f", 32: "g", 38: "h", 5: "i",
    8: "j", 9: "k", 35: "l", 46: "m", 37: "n", 1: "o", 15: "p", 7: "q",
    31: "r", 41: "s", 40: "t", 3: "u", 47: "v", 43: "w", 11: "x", 17: "y", 44: "z",
  ]

  @Test func usShortcutsKeepTheirLetterAndDigitPositionsInBothLayers() {
    let map = KeyboardLayoutMap { code, _, _ in us[code] }
    for (code, text) in us {
      for command in [false, true] {
        #expect(map.keyCode(for: Character(text), command: command, control: false) == code)
      }
    }
    #expect(map.keyCode(for: ",", command: true, control: false) == nil)
  }

  @Test func azertyUsesMovedLettersAndRefusesShiftOnlyDigits() {
    var azerty = us
    for (code, text) in [
      UInt16(12): "a", 0: "q", 6: "w", 13: "z", 41: "m", 46: ",",
      18: "&", 19: "\u{00e9}", 20: "\"", 21: "'", 23: "(", 22: "\u{00a7}",
      26: "\u{00e8}", 28: "!", 25: "\u{00e7}", 29: "\u{00e0}",
    ] {
      azerty[code] = text
    }
    let map = KeyboardLayoutMap { code, _, _ in azerty[code] }
    for command in [false, true] {
      #expect(map.keyCode(for: "a", command: command, control: false) == 12)
      #expect(map.keyCode(for: "q", command: command, control: false) == 0)
      #expect(map.keyCode(for: "w", command: command, control: false) == 6)
      #expect(map.keyCode(for: "z", command: command, control: false) == 13)
      #expect(map.keyCode(for: "m", command: command, control: false) == 41)
      for digit in "0123456789" {
        #expect(map.keyCode(for: digit, command: command, control: false) == nil)
      }
    }
  }

  @Test func plainDvorakCommandShortcutsUseDvorakPositions() {
    let map = KeyboardLayoutMap { code, _, _ in dvorak[code] }
    #expect(map.keyCode(for: "w", command: true, control: false) == 43)
    #expect(map.keyCode(for: "w", command: false, control: false) == 43)
  }

  @Test func dvorakQwertyCommandChoosesTheRequestedLayer() {
    let map = KeyboardLayoutMap { code, command, _ in (command ? us : dvorak)[code] }
    #expect(map.keyCode(for: "w", command: true, control: false) == 13)
    #expect(map.keyCode(for: "w", command: false, control: false) == 43)
  }

  @Test func russianUsesLatinCommandKeysWithoutFallingBackForUnmodifiedKeys() {
    let map = KeyboardLayoutMap { code, command, _ in
      command ? us[code] : [UInt16(13): "\u{0446}", 0: "\u{0444}"][code]
    }
    #expect(map.keyCode(for: "w", command: true, control: false) == 13)
    #expect(map.keyCode(for: "w", command: false, control: false) == nil)
  }

  @Test func dvorakQwertyCommandRefusesControlCWhenNeitherPositionMatchesBothLayers() {
    let map = KeyboardLayoutMap { code, command, control in
      if control { return [UInt16(34): "\u{0009}", 8: "\u{0003}"][code] }
      return (command ? us : dvorak)[code]
    }
    #expect(map.keyCode(for: "c", command: false, control: true) == nil)
    #expect(map.keyCode(for: "c", command: true, control: true) == 8)
  }

  @Test func polishRefusesControlZWhenTheControlLayerTypesControlY() {
    let map = KeyboardLayoutMap { code, _, control in
      code == 16 ? (control ? "\u{0019}" : "z") : nil
    }
    for command in [false, true] {
      #expect(map.keyCode(for: "z", command: command, control: true) == nil)
    }
  }

  @Test func usControlCAcceptsTheMatchingControlCharacter() {
    let map = KeyboardLayoutMap { code, _, control in
      code == 8 ? (control ? "\u{0003}" : "c") : nil
    }
    for command in [false, true] {
      #expect(map.keyCode(for: "c", command: command, control: true) == 8)
    }
  }

  @Test func controlDigitsRequireTheDigitInTheControlLayer() {
    let map = KeyboardLayoutMap { code, _, control in
      if control { return [UInt16(18): "1", 19: "\u{0000}"][code] }
      return [UInt16(18): "1", 19: "2"][code]
    }
    for command in [false, true] {
      #expect(map.keyCode(for: "1", command: command, control: true) == 18)
      #expect(map.keyCode(for: "2", command: command, control: true) == nil)
    }
  }

  @Test func missingDeadKeyAndMultiCharacterOutputCannotBecomeShortcuts() {
    let map = KeyboardLayoutMap { code, _, _ in
      [UInt16(1): "ww", 2: "", 3: "a\u{0301}"][code]
    }
    for command in [false, true] {
      for control in [false, true] {
        #expect(map.keyCode(for: "a", command: command, control: control) == nil)
        #expect(map.keyCode(for: "w", command: command, control: control) == nil)
      }
    }
    for output in ["ww", "", "w\u{0301}"] {
      let controlledMap = KeyboardLayoutMap { code, _, control in
        code == 13 ? (control ? output : "w") : nil
      }
      for command in [false, true] {
        #expect(controlledMap.keyCode(for: "w", command: command, control: true) == nil)
      }
    }
  }

  @Test func keypadOutputCannotSupplyAMissingMainBlockDigit() {
    let map = KeyboardLayoutMap { code, _, _ in code == 83 ? "1" : nil }
    #expect(map.keyCode(for: "1", command: false, control: false) == nil)
    #expect(map.keyCode(for: "1", command: true, control: false) == nil)
  }

  @Test func duplicateCharactersUseTheLowestKeyCodeInEachLayer() {
    let map = KeyboardLayoutMap { code, command, control in
      if control && code == 6 { return "\u{0019}" }
      return (command ? [UInt16(13), 43] : [UInt16(6), 13]).contains(code) ? "w" : nil
    }
    #expect(map.keyCode(for: "w", command: false, control: false) == 6)
    #expect(map.keyCode(for: "w", command: false, control: true) == 13)
    for control in [false, true] {
      #expect(map.keyCode(for: "w", command: true, control: control) == 13)
    }
  }
}

private func installedLayoutData(_ id: String) -> CFData? {
  func read() -> CFData? {
    let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
    guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource],
      let source = list.first,
      let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    return Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
  }
  return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
}

@Suite struct KeyboardLayoutMapInstalledTests {
  @Test func unavailableLayoutReturnsNoData() {
    #expect(installedLayoutData("com.stim.test.missing-keyboard-layout") == nil)
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.US") != nil))
  func usTranslatesWInBothLayers() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.US")))
    #expect(map.keyCode(for: "w", command: false, control: false) == 13)
    #expect(map.keyCode(for: "w", command: true, control: false) == 13)
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.ABC-AZERTY") != nil))
  func azertyTranslatesAAndRefusesDigitsInBothLayers() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.ABC-AZERTY")))
    for command in [false, true] {
      #expect(map.keyCode(for: "a", command: command, control: false) == 12)
      #expect(map.keyCode(for: "1", command: command, control: false) == nil)
    }
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.DVORAK-QWERTYCMD") != nil))
  func dvorakQwertyCommandTranslatesDifferentWPositions() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.DVORAK-QWERTYCMD")))
    #expect(map.keyCode(for: "w", command: false, control: false) == 43)
    #expect(map.keyCode(for: "w", command: true, control: false) == 13)
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.DVORAK-QWERTYCMD") != nil))
  func dvorakQwertyCommandControlCDoesNotUseTheControlIPosition() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.DVORAK-QWERTYCMD")))
    #expect(map.keyCode(for: "c", command: false, control: true) != 34)
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.Polish") != nil))
  func polishControlZDoesNotUseTheControlYPosition() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.Polish")))
    for command in [false, true] {
      #expect(map.keyCode(for: "z", command: command, control: true) != 16)
    }
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.Russian") != nil))
  func russianTranslatesLatinWOnlyWithCommand() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.Russian")))
    #expect(map.keyCode(for: "w", command: false, control: false) == nil)
    #expect(map.keyCode(for: "w", command: true, control: false) == 13)
  }
}
