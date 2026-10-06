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
    let map = KeyboardLayoutMap { code, _ in us[code] }
    for (code, text) in us {
      for command in [false, true] {
        #expect(map.keyCode(for: Character(text), command: command) == code)
      }
    }
    #expect(map.keyCode(for: ",", command: true) == nil)
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
    let map = KeyboardLayoutMap { code, _ in azerty[code] }
    for command in [false, true] {
      #expect(map.keyCode(for: "a", command: command) == 12)
      #expect(map.keyCode(for: "q", command: command) == 0)
      #expect(map.keyCode(for: "w", command: command) == 6)
      #expect(map.keyCode(for: "z", command: command) == 13)
      #expect(map.keyCode(for: "m", command: command) == 41)
      for digit in "0123456789" {
        #expect(map.keyCode(for: digit, command: command) == nil)
      }
    }
  }

  @Test func plainDvorakCommandShortcutsUseDvorakPositions() {
    let map = KeyboardLayoutMap { code, _ in dvorak[code] }
    #expect(map.keyCode(for: "w", command: true) == 43)
    #expect(map.keyCode(for: "w", command: false) == 43)
  }

  @Test func dvorakQwertyCommandChoosesTheRequestedLayer() {
    let map = KeyboardLayoutMap { code, command in (command ? us : dvorak)[code] }
    #expect(map.keyCode(for: "w", command: true) == 13)
    #expect(map.keyCode(for: "w", command: false) == 43)
  }

  @Test func russianUsesLatinCommandKeysWithoutFallingBackForUnmodifiedKeys() {
    let map = KeyboardLayoutMap { code, command in
      command ? us[code] : [UInt16(13): "\u{0446}", 0: "\u{0444}"][code]
    }
    #expect(map.keyCode(for: "w", command: true) == 13)
    #expect(map.keyCode(for: "w", command: false) == nil)
  }

  @Test func missingDeadKeyAndMultiCharacterOutputCannotBecomeShortcuts() {
    let map = KeyboardLayoutMap { code, _ in
      [UInt16(1): "ww", 2: "", 3: "a\u{0301}"][code]
    }
    for command in [false, true] {
      #expect(map.keyCode(for: "a", command: command) == nil)
      #expect(map.keyCode(for: "w", command: command) == nil)
    }
  }

  @Test func keypadOutputCannotSupplyAMissingMainBlockDigit() {
    let map = KeyboardLayoutMap { code, _ in code == 83 ? "1" : nil }
    #expect(map.keyCode(for: "1", command: false) == nil)
    #expect(map.keyCode(for: "1", command: true) == nil)
  }

  @Test func duplicateCharactersUseTheLowestKeyCodeInEachLayer() {
    let map = KeyboardLayoutMap { code, command in
      (command ? [UInt16(13), 43] : [UInt16(6), 13]).contains(code) ? "w" : nil
    }
    #expect(map.keyCode(for: "w", command: false) == 6)
    #expect(map.keyCode(for: "w", command: true) == 13)
  }
}

private func installedLayoutData(_ id: String) -> CFData? {
  func read() -> CFData? {
    let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
    let sources = TISCreateInputSourceList(filter, true).takeRetainedValue() as! [TISInputSource]
    guard let source = sources.first,
      let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    return Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
  }
  return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
}

@Suite struct KeyboardLayoutMapInstalledTests {
  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.US") != nil))
  func usTranslatesWInBothLayers() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.US")))
    #expect(map.keyCode(for: "w", command: false) == 13)
    #expect(map.keyCode(for: "w", command: true) == 13)
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.ABC-AZERTY") != nil))
  func azertyTranslatesAAndRefusesDigitsInBothLayers() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.ABC-AZERTY")))
    for command in [false, true] {
      #expect(map.keyCode(for: "a", command: command) == 12)
      #expect(map.keyCode(for: "1", command: command) == nil)
    }
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.DVORAK-QWERTYCMD") != nil))
  func dvorakQwertyCommandTranslatesDifferentWPositions() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.DVORAK-QWERTYCMD")))
    #expect(map.keyCode(for: "w", command: false) == 43)
    #expect(map.keyCode(for: "w", command: true) == 13)
  }

  @Test(.enabled(if: installedLayoutData("com.apple.keylayout.Russian") != nil))
  func russianTranslatesLatinWOnlyWithCommand() throws {
    let map = KeyboardLayoutMap(layoutData: try #require(installedLayoutData("com.apple.keylayout.Russian")))
    #expect(map.keyCode(for: "w", command: false) == nil)
    #expect(map.keyCode(for: "w", command: true) == 13)
  }
}
