import Foundation
import Testing

@testable import SimulatorFrames

@Suite struct SimulatorKitPathTests {
  @Test func resolvesBothXcodeFrameworkLayoutsWithinTheSelectedInstallation() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let developer = root.appendingPathComponent("Xcode.app/Contents/Developer")
    try FileManager.default.createDirectory(at: developer, withIntermediateDirectories: true)
    let shared = developer.path + "/../SharedFrameworks/SimulatorKit.framework/SimulatorKit"
    let legacy = developer.path + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
    #expect(CoreSimulator.simulatorKitPath(developer.path) == shared)
    try FileManager.default.createDirectory(
      atPath: (legacy as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data().write(to: URL(fileURLWithPath: legacy))
    #expect(CoreSimulator.simulatorKitPath(developer.path) == legacy)
    try FileManager.default.createDirectory(
      atPath: (shared as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data().write(to: URL(fileURLWithPath: shared))
    #expect(CoreSimulator.simulatorKitPath(developer.path) == shared)
  }
}
