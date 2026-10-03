import Foundation
import Testing

@testable import StimKit

@Suite struct XcodeLogPresentationTests {
  private func entry(_ message: String, slot: String = "ios", extra: [String: Any] = [:]) throws -> LogEntry {
    var value: [String: Any] = ["ts": 1, "src": "build", "level": "debug", "msg": message, "slot": slot]
    value.merge(extra) { _, new in new }
    let record = try JSONDecoder().decode(LogRecord.self, from: JSONSerialization.data(withJSONObject: value))
    return LogEntry(lead: record, related: [], relatedBefore: 0, context: [])
  }

  @Test func simplifiesCompilationAndSuppressesRecognizedInvocationNoiseWithoutChangingRawText() throws {
    let entries = try [
      entry(
        "CompileC /tmp/App.o /project/App.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target 'App' from project 'App')"
      ),
      entry("    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -c /project/App.m"),
    ]
    let presentation = XcodeLogPresentation()
    presentation.update(entries, from: 0)
    #expect(presentation.messages[0]?.contains("Compiling App.m") == true)
    #expect(presentation.messages[1] == nil)
  }

  @Test func keepsDiagnosticSourceAndCaretAcrossBatchesAndInterleavedSlots() throws {
    var entries = try [entry("/project/App.swift:7:3: warning: deprecated API")]
    let presentation = XcodeLogPresentation()
    presentation.update(entries, from: 0)
    #expect(presentation.messages[0]?.contains("deprecated API") == true)
    entries += try [
      entry("    /usr/bin/clang -c Other.m", slot: "other"),
      entry("    oldAPI()"),
    ]
    presentation.update(entries, from: 1)
    #expect(presentation.messages[2] == "    oldAPI()")
    entries += try [entry("    ^~~~~~~~")]
    presentation.update(entries, from: 3)
    #expect(presentation.messages[3] == "    ^~~~~~~~")
  }

  @Test func preservesErrorsUnknownScriptTextAndNonXcodeSources() throws {
    let entries = try [
      entry("/project/App.swift:9:1: error: cannot find value 'missing' in scope"),
      entry("missing()"),
      entry("^~~~~~~"),
      entry("custom build script output"),
      entry("    /usr/bin/clang -c Other.m", extra: ["raw": true, "event": "gradle"]),
      entry("structured build refusal", extra: ["level": "error", "event": "build_diagnostic"]),
      entry("application message", extra: ["src": "client"]),
    ]
    let presentation = XcodeLogPresentation()
    presentation.update(entries, from: 0)
    #expect(presentation.messages[0]?.contains("cannot find value 'missing'") == true)
    #expect(Array(presentation.messages[1...]) == entries[1...].map { Optional($0.lead.msg) })
  }

  @Test func restoresContinuationStateWhenTheChangedSuffixIsReplaced() throws {
    var entries = try [entry("/project/App.swift:7:3: warning: deprecated API"), entry("oldAPI()")]
    let presentation = XcodeLogPresentation()
    presentation.update(entries, from: 0)
    entries[1] = try entry("changedAPI()")
    presentation.update(entries, from: 1)
    entries += try [entry("^~~~~~~~~~~~")]
    presentation.update(entries, from: 2)
    #expect(presentation.messages[1] == "changedAPI()")
    #expect(presentation.messages[2] == "^~~~~~~~~~~~")
  }

  @Test func keepsDiagnosticContinuationWhenOldRecordsAreTrimmed() throws {
    var entries = try [
      entry("/project/App.swift:7:3: warning: deprecated API"),
      entry("    /usr/bin/clang -c sourceMentionedInDiagnostic"),
    ]
    let presentation = XcodeLogPresentation()
    presentation.update(entries, from: 0)
    entries.removeFirst()
    presentation.dropFirst(1)
    #expect(presentation.messages == [entries[0].lead.msg])
    entries += try [entry("    ^~~~~~~~~~~")]
    presentation.update(entries, from: 1)
    #expect(presentation.messages == entries.map { Optional($0.lead.msg) })
    presentation.update(entries, from: 0)
    #expect(presentation.messages == entries.map { Optional($0.lead.msg) })
  }

}
