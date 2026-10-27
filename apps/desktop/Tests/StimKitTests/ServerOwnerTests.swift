import Foundation
import StimKit
import Testing

struct ServerOwnerTests {
  private func workspace(path: String, udid: String) throws -> Workspace {
    let json = #"""
      {"path":"\#(path)","live":true,"warnings":[],
       "ios":{"name":"stim-app (iPhone 17 26.0)","udid":"\#(udid)","owned":true,"state":"Booted"},
       "android":{"name":"stim-app","serial":"emulator-5554","owned":true,"physical":false,"state":"detected"}}
      """#
    return try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
  }

  @Test func aPairedServersSimulatorNeverResolvesToOneOnThisMac() throws {
    let reported = try workspace(path: "/Users/me/app", udid: "1A2B")
    let local = OwnedWorkspace(owner: .local, workspace: reported)
    let paired = OwnedWorkspace(owner: .paired("SHA256:floco"), workspace: reported)

    #expect(local.devices.map(\.localSimulatorUDID) == ["1A2B", nil])
    #expect(local.devices.map(\.localEmulatorSerial) == [nil, "emulator-5554"])
    #expect(paired.devices.allSatisfy { $0.ref.hostedMachine == nil })
    #expect(paired.devices.allSatisfy { $0.localSimulatorUDID == nil && $0.localEmulatorSerial == nil })
    #expect(paired.devices.allSatisfy { $0.activityKey == nil })
  }

  @Test func theSameUDIDAndPathOnTwoServersKeepDistinctIdentities() throws {
    let reported = try workspace(path: "/Users/me/app", udid: "1A2B")
    let owners: [ServerOwner] = [.local, .paired("SHA256:floco"), .paired("SHA256:mini")]
    let workspaces = owners.map { OwnedWorkspace(owner: $0, workspace: reported) }

    #expect(Set(workspaces.map(\.id)).count == 3)
    #expect(Set(workspaces.flatMap(\.devices).map(\.id)).count == 6)
    #expect(workspaces[0].id == "/Users/me/app")
    #expect(workspaces[0].devices.map(\.id) == reported.devices.map(\.id))
    #expect(workspaces.map(\.key.localPath) == ["/Users/me/app", nil, nil])
  }
}
