import Foundation
import Testing

@testable import StimKit

/// The phone mock server's status capture is a real Mac's `stim status --json`; the desktop decodes the same payload.
@Suite struct CapturedStatusTests {
  static let captureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("mobile/mock-server/fixtures/status.json")

  static func capture() throws -> (raw: [String: Any], data: Data) {
    let wrapper = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: captureURL)) as? [String: Any])
    let raw = try #require(wrapper["payload"] as? [String: Any])
    return (raw, try JSONSerialization.data(withJSONObject: raw))
  }

  private static func count(_ value: Any?) -> Int? { (value as? [Any])?.count }

  private static func has(_ object: [String: Any], _ key: String) -> Bool {
    guard let value = object[key] else { return false }
    return !(value is NSNull)
  }

  @Test func decodesEveryTopLevelSectionOfTheCapture() throws {
    let (raw, data) = try Self.capture()
    let payload = try JSONDecoder().decode(StatusPayload.self, from: data)
    #expect(payload.environments.count == Self.count(raw["environments"]))
    #expect(payload.unprovisionedWorktrees?.count == Self.count(raw["unprovisionedWorktrees"]))
    #expect(payload.archived?.count == Self.count(raw["archived"]))
    #expect((payload.capacity != nil) == Self.has(raw, "capacity"))
    #expect((payload.machine != nil) == Self.has(raw, "machine"))
    #expect(payload.machine?.owners.count == Self.count((raw["machine"] as? [String: Any])?["owners"]))
    #expect((payload.archivedUsage != nil) == Self.has(raw, "archivedUsage"))
    #expect(payload.oversight != nil)
  }

  @Test func keepsEveryWorkspaceSectionOfTheCapture() throws {
    let (raw, data) = try Self.capture()
    let payload = try JSONDecoder().decode(StatusPayload.self, from: data)
    let environments = try #require(raw["environments"] as? [[String: Any]])
    for (json, workspace) in zip(environments, payload.environments) {
      let path = workspace.path
      #expect(path == json["path"] as? String)
      let decoded: [String: Bool] = [
        "ios": workspace.ios != nil, "android": workspace.android != nil, "web": workspace.web != nil,
        "macos": workspace.macos != nil, "metro": workspace.metro != nil, "supervisor": workspace.supervisor != nil,
        "logs": workspace.logs != nil, "build": workspace.build != nil, "lastBuilds": workspace.lastBuilds != nil,
        "worktree": workspace.worktree != nil, "disk": workspace.disk != nil, "memoryMb": workspace.memoryMb != nil,
      ]
      for (key, present) in decoded { #expect(present == Self.has(json, key), "\(path) \(key)") }
      #expect(workspace.slots?.count == Self.count(json["slots"]), "\(path) slots")
      #expect(workspace.issues?.count == Self.count(json["issues"]), "\(path) issues")
      #expect(workspace.remoteDevices?.count == Self.count(json["remoteDevices"]), "\(path) remoteDevices")
      #expect(workspace.physicalDevices?.count == Self.count(json["physicalDevices"]), "\(path) physicalDevices")
      #expect(workspace.agents?.count == Self.count(json["agents"]), "\(path) agents")
      #expect(workspace.endedAgents?.count == Self.count(json["endedAgents"]), "\(path) endedAgents")
      let builds = json["builds"] as? [String: Any]
      for platform in ["ios", "android", "macos"] {
        let entries = workspace.builds?.builds(for: platform).count ?? 0
        #expect(entries == (Self.count(builds?[platform]) ?? 0), "\(path) builds.\(platform)")
      }
      let slots = json["slots"] as? [[String: Any]] ?? []
      for (slotJSON, slot) in zip(slots, workspace.slots ?? []) {
        #expect((slot.ios != nil) == Self.has(slotJSON, "ios"), "\(path) slot \(slot.slot) ios")
        #expect((slot.android != nil) == Self.has(slotJSON, "android"), "\(path) slot \(slot.slot) android")
      }
    }
  }
}
