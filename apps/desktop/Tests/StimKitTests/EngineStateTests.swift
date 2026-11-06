import CryptoKit
import Foundation
import Testing

@testable import StimKit

@Suite struct EngineStateTests {
  private func scratch() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("engine-state-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  @Test func nativeReadsRefuseAFormatThisDesktopDoesNotKnow() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("stimd.json")
    #expect(EngineFiles.read(StimdRecord.self, at: file.path) == .missing)
    let fields = #""pid":42,"socket":"/h/run/stimd.sock","build":"3f9a1c0d22e8","version":"1.43.0""#
    try Data("{\"format\":1,\(fields)}".utf8).write(to: file)
    #expect(EngineFiles.read(StimdRecord.self, at: file.path).value?.socket == "/h/run/stimd.sock")
    try Data("{\"format\":2,\(fields)}".utf8).write(to: file)
    guard case .unknownFormat(let text) = EngineFiles.read(StimdRecord.self, at: file.path) else {
      Issue.record("format 2 must be refused")
      return
    }
    #expect(text.contains("format 2") && text.hasSuffix("update Stim Desktop (Stim > Check for Updates)."))
    try Data("{\(fields)}".utf8).write(to: file)
    #expect(
      EngineFiles.read(StimdRecord.self, at: file.path) == .unknownFormat(EngineFiles.unknownFormatText(file.path, format: nil)))
    try Data("{\"format\":1,\"pid\":42}".utf8).write(to: file)
    #expect(EngineFiles.read(StimdRecord.self, at: file.path) == .unreadable)
    try Data("not json".utf8).write(to: file)
    #expect(EngineFiles.read(StimdRecord.self, at: file.path) == .unreadable)
  }

  @Test func theEngineRootFollowsAnAbsoluteOverrideAndKeepsTheRuntimeBesideIt() {
    #expect(EngineRoot(environment: [:], home: "/Users/me").path == "/Users/me/.stim/engine")
    #expect(EngineRoot(environment: ["STIM_ENGINE_ROOT": "relative"], home: "/Users/me").path == "/Users/me/.stim/engine")
    let scratch = EngineRoot(environment: ["STIM_ENGINE_ROOT": "/tmp/s/engine", "STIM_HOME": "/tmp/h"], home: "/Users/me")
    #expect(scratch.stimd == "/tmp/s/engine/bin/stimd")
    #expect(scratch.runtime == "/tmp/s/runtime")
  }

  private func pointer(_ version: String, pinned: Bool = false) throws -> EnginePointer {
    try JSONDecoder().decode(
      EnginePointer.self,
      from: Data(
        #"{"format":1,"version":"\#(version)","build":"3f9a1c0d22e8","dir":"3f9a1c0d22e8","node":[],"channel":"latest","pinned":\#(pinned),"pinReason":"rolled back from 1.44.0","setBy":"rollback"}"#
          .utf8))
  }

  @Test func onboardingInstallsUpdatesOrShowsThePinFromTheStoreAndTheVersionThisBuildNames() throws {
    let wanted = SemanticVersion("1.44.0")
    #expect(EngineNeed.decide(pointer: .missing, wanted: wanted, installedByDesktop: false) == .install(version: "1.44.0"))
    #expect(EngineNeed.decide(pointer: .unreadable, wanted: nil, installedByDesktop: false) == .install(version: "next"))
    #expect(
      EngineNeed.decide(pointer: .unknownFormat("update"), wanted: wanted, installedByDesktop: true) == .unreadable("update"))
    let same = try pointer("1.44.0")
    #expect(EngineNeed.decide(pointer: .found(same), wanted: wanted, installedByDesktop: false) == .ready(same))
    let newer = try pointer("1.45.0-next.20261106", pinned: true)
    #expect(EngineNeed.decide(pointer: .found(newer), wanted: wanted, installedByDesktop: false) == .ready(newer))
    let older = try pointer("1.43.0")
    #expect(EngineNeed.decide(pointer: .found(older), wanted: nil, installedByDesktop: false) == .ready(older))
    #expect(
      EngineNeed.decide(pointer: .found(older), wanted: wanted, installedByDesktop: true)
        == .moveForward(older, automatic: true))
    #expect(
      EngineNeed.decide(pointer: .found(older), wanted: wanted, installedByDesktop: false)
        == .moveForward(older, automatic: false))
    let pinned = try pointer("1.43.0", pinned: true)
    guard case .pinned(_, let text) = EngineNeed.decide(pointer: .found(pinned), wanted: wanted, installedByDesktop: true)
    else {
      Issue.record("a pinned older engine is shown, never moved")
      return
    }
    #expect(text.contains("pinned at 1.43.0 (rolled back from 1.44.0)") && text.contains("needs 1.44.0"))

    let old = NodeRuntime(path: "/usr/local/bin/node", version: "20.11.0")
    let current = NodeRuntime(path: "/opt/homebrew/bin/node", version: "22.12.0")
    let managed = NodeRuntime(path: "/Users/me/.stim/runtime/node-v24.21.0-darwin-arm64/bin/node", version: "24.21.0")
    #expect(NodeChoice.decide(system: current, managed: managed) == .use(current))
    #expect(NodeChoice.decide(system: old, managed: managed) == .use(managed))
    #expect(NodeChoice.decide(system: old, managed: nil) == .download)
    #expect(NodeChoice.decide(system: nil, managed: nil) == .download)
  }

  @Test func theManagedNodeArchiveMustMatchBothThePinAndTheReleaseChecksums() throws {
    let sums = try String(
      contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(
        "Fixtures/SHASUMS256.txt"),
      encoding: .utf8)
    let pinned = try #require(ManagedNode.archiveSHA256["arm64"])
    #expect(throws: ManagedNode.Failure.self) {
      try ManagedNode.verify(archive: Data("not node".utf8), sums: sums, architecture: "arm64", pinned: pinned)
    }
    let archive = Data("an archive".utf8)
    let digest = SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined()
    #expect(throws: ManagedNode.Failure.self) {
      try ManagedNode.verify(archive: archive, sums: sums, architecture: "arm64", pinned: digest)
    }
    let listing = "\(digest)  \(ManagedNode.archiveName(architecture: "x64"))\n"
    try ManagedNode.verify(archive: archive, sums: listing, architecture: "x64", pinned: digest)
    #expect(throws: ManagedNode.Failure.self) {
      try ManagedNode.verify(archive: archive + Data([0]), sums: listing, architecture: "x64", pinned: digest)
    }
    #expect(throws: ManagedNode.Failure.self) {
      try ManagedNode.verify(archive: archive, sums: listing, architecture: "arm64", pinned: digest)
    }
  }
}
