import Testing

@testable import StimKit

private let textTypes = ["public.utf8-plain-text", "public.html"]

private func board(_ text: String?, count: Int, types: [String] = textTypes) -> PasteboardSnapshot {
  PasteboardSnapshot(changeCount: count, types: types, text: text)
}

@Suite struct ClipboardSyncTests {
  @Test func neverCopiesConcealedTransientFileOrImageItems() {
    for extra in [
      "org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "public.file-url", "public.png", "public.tiff",
    ] {
      #expect(ClipboardSync.macText(board("secret", count: 1, types: textTypes + [extra])) == nil)
    }
    #expect(ClipboardSync.macText(board("hello", count: 1)) == "hello")
  }

  @Test func skipsItemsWithoutTextAndEmptyOrOversizedText() {
    #expect(ClipboardSync.macText(board(nil, count: 1, types: ["public.png"])) == nil)
    #expect(ClipboardSync.macText(board("", count: 1)) == nil)
    let big = String(repeating: "a", count: ClipboardSync.maxTextBytes + 1)
    #expect(ClipboardSync.macText(board(big, count: 1)) == nil)
    #expect(ClipboardSync.deviceText(big) == nil)
    #expect(ClipboardSync.deviceText("") == nil)
    #expect(ClipboardSync.deviceText("h\u{e9}llo\nw\u{f6}rld") == "h\u{e9}llo\nw\u{f6}rld")
  }

  @Test func syncsOnlyWhenEnabledForAControlledDeviceAndTheWindowIsVisible() {
    #expect(ClipboardSync.activity(enabled: true, hasTarget: true, window: .key) == .sync)
    #expect(ClipboardSync.activity(enabled: true, hasTarget: true, window: .visible) == .flush)
    #expect(ClipboardSync.activity(enabled: true, hasTarget: true, window: .hidden) == .none)
    #expect(ClipboardSync.activity(enabled: false, hasTarget: true, window: .key) == .none)
    #expect(ClipboardSync.activity(enabled: true, hasTarget: false, window: .key) == .none)
  }

  @Test func copiesTheMacClipboardWhenTheViewerBecomesKeyOrTheClipboardChanges() {
    var sync = ClipboardSync()
    #expect(sync.textForDevice(board("one", count: 5), becameKey: true) == "one")
    sync.didCopyToDevice("one")
    #expect(sync.textForDevice(board("one", count: 5), becameKey: false) == nil)
    #expect(sync.textForDevice(board("one", count: 5), becameKey: true) == nil)
    #expect(sync.textForDevice(board("two", count: 6), becameKey: false) == "two")
  }

  @Test func neverCopiesAConcealedItemAndStillSeesLaterChanges() {
    var sync = ClipboardSync()
    sync.didCopyToDevice("one")
    let concealed = board("pw", count: 7, types: textTypes + ["org.nspasteboard.ConcealedType"])
    #expect(sync.textForDevice(concealed, becameKey: true) == nil)
    #expect(sync.textForDevice(concealed, becameKey: false) == nil)
    #expect(sync.textForDevice(board("three", count: 8), becameKey: false) == "three")
  }

  @Test func openingTheViewerNeverReplacesTheMacClipboard() {
    var sync = ClipboardSync()
    let concealed = board("pw", count: 1, types: textTypes + ["org.nspasteboard.ConcealedType"])
    #expect(sync.textForDevice(concealed, becameKey: true) == nil)
    #expect(sync.textForMac(deviceText: "old device text") == nil)
    #expect(sync.textForMac(deviceText: "old device text") == nil)
    #expect(sync.textForMac(deviceText: "copied on the device") == "copied on the device")
  }

  @Test func aDeviceThatStartedEmptyStillSyncsItsFirstCopy() {
    var sync = ClipboardSync()
    #expect(sync.textForMac(deviceText: nil) == nil)
    #expect(sync.textForMac(deviceText: "") == nil)
    #expect(sync.textForMac(deviceText: "first") == "first")
  }

  @Test func doesNotEchoTextBetweenTheSides() {
    var sync = ClipboardSync()
    #expect(sync.textForMac(deviceText: "a") == nil)
    #expect(sync.textForMac(deviceText: "b") == "b")
    sync.didCopyToMac("b", changeCount: 10)
    #expect(sync.textForMac(deviceText: "b") == nil)
    #expect(sync.textForDevice(board("b", count: 10), becameKey: false) == nil)
    #expect(sync.textForDevice(board("b", count: 10), becameKey: true) == nil)
    #expect(sync.textForDevice(board("c", count: 11), becameKey: false) == "c")
    sync.didCopyToDevice("c")
    #expect(sync.textForMac(deviceText: "c") == nil)
  }

  @Test func aFailedDeviceReadChangesNothing() {
    var sync = ClipboardSync()
    #expect(sync.textForMac(deviceText: "a") == nil)
    #expect(sync.textForMac(deviceText: nil) == nil)
    #expect(sync.synced == "a")
  }
}
