import Foundation
import Testing

@testable import StimKit

struct WorkspaceDiffTests {
  private func decode(_ json: String) throws -> WorkspaceDiff {
    try JSONDecoder().decode(WorkspaceDiff.self, from: Data(json.utf8))
  }

  @Test func decodesEveryPatchKind() throws {
    let diff = try decode(
      """
      {"path":"a","patches":[
        {"section":"staged","kind":"text","text":"x"},
        {"section":"unstaged","kind":"binary","text":""},
        {"section":"unstaged","kind":"too-large","text":""},
        {"section":"untracked","kind":"unavailable","text":"why"}]}
      """)
    #expect(diff.patches.map(\.kind) == [.text, .binary, .tooLarge, .unavailable])
    #expect(diff.patches.map(\.section.title) == ["Staged", "Unstaged", "Unstaged", "New file"])
  }

  @Test func rowsKeepIdsUniqueAcrossSectionsAndLeaveFileHeadersPlain() throws {
    let patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n context\n"
    let diff = try decode(
      """
      {"path":"f","patches":[
        {"section":"staged","kind":"text","text":\(json(patch))},
        {"section":"unstaged","kind":"text","text":\(json(patch))}]}
      """)
    let rows = diff.rows
    #expect(Set(rows.map(\.id)).count == rows.count)
    #expect(rows.filter { $0.kind == .title }.map(\.text) == ["Staged", "Unstaged"])
    let staged = rows.filter { $0.id.hasPrefix("0:") && $0.kind != .title }
    #expect(staged.map(\.kind) == [.plain, .plain, .plain, .hunk, .removed, .added, .context])
  }

  @Test func newFileTextIsNeverMarkedAsAChange() throws {
    let diff = try decode(#"{"path":"n","patches":[{"section":"untracked","kind":"text","text":"+a\n-b\n@@ c\n"}]}"#)
    #expect(diff.rows.dropFirst().map(\.kind) == [.plain, .plain, .plain])
  }

  @Test func windowsLineEndingsSplitIntoRows() throws {
    let diff = try decode(#"{"path":"n","patches":[{"section":"unstaged","kind":"text","text":"@@ -1 +1 @@\r\n-a\r\n+b\r\n"}]}"#)
    #expect(diff.rows.dropFirst().map(\.text) == ["@@ -1 +1 @@", "-a", "+b"])
    #expect(diff.rows.dropFirst().map(\.kind) == [.hunk, .removed, .added])
  }

  @Test func unavailablePatchesShowANoteInsteadOfLines() throws {
    let diff = try decode(#"{"path":"n","patches":[{"section":"unstaged","kind":"binary","text":""}]}"#)
    #expect(diff.rows.map(\.kind) == [.title, .note])
  }

  private func json(_ text: String) -> String {
    String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
  }
}
