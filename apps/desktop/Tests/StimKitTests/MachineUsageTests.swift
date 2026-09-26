import Foundation
import Testing

@testable import StimKit

@Suite struct MachineUsageTests {
  @Test func decodesTheStatusMachineSectionAndToleratesUnknownKinds() throws {
    let json = """
      {"environments":[],"machine":{"owners":[
        {"kind":"simulator","name":"stim-app (iPhone 17)","workspace":"/w/a","slot":"tablet","id":"UDID","owned":true,"cpuPercent":12,"residentMb":2071,"processes":310},
        {"kind":"gpu","name":"future","workspace":null,"id":null,"owned":false,"cpuPercent":1,"residentMb":2,"processes":1}
      ]}}
      """
    let payload = try JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    let owners = try #require(payload.machine?.owners)
    #expect(owners[0].kind == .simulator && owners[0].slot == "tablet" && owners[0].residentMb == 2071)
    #expect(owners[1].kind == .other)
    #expect(try JSONDecoder().decode(StatusPayload.self, from: Data(#"{"environments":[]}"#.utf8)).machine == nil)
  }

  @Test func onlyAWorkspacesOwnedDeviceOrMetroGetsAStopAction() {
    let device = MachineOwner(kind: .simulator, name: "sim", workspace: "/w/a", owned: true)
    #expect(device.stopCommand == StimCommand(["stop", "--slot", "default"], cwd: "/w/a"))
    #expect(device.stopTitle == "Shut down")
    let slotted = MachineOwner(kind: .emulator, name: "avd", workspace: "/w/a", slot: "fold", owned: true)
    #expect(slotted.stopCommand == StimCommand(["stop", "--slot", "fold"], cwd: "/w/a"))
    let metro = MachineOwner(kind: .metro, name: "Metro :8081", workspace: "/w/a", owned: true)
    #expect(metro.stopCommand == StimCommand(["stop"], cwd: "/w/a"))
    #expect(metro.stopTitle == "Stop")

    let notOwned: [MachineOwner] = [
      MachineOwner(kind: .simulator, name: "user sim", workspace: nil, owned: false),
      MachineOwner(kind: .simulator, name: "recorded, not owned", workspace: "/w/a", owned: false),
      MachineOwner(kind: .build, name: "iOS build", workspace: "/w/a", owned: true),
      MachineOwner(kind: .browser, name: "Chrome", workspace: "/w/a", owned: true),
      MachineOwner(kind: .server, name: "stim-server"),
      MachineOwner(kind: .shared, name: "CoreSimulator services"),
    ]
    for owner in notOwned {
      #expect(owner.stopCommand == nil && owner.stopTitle == nil, "\(owner.name)")
    }
  }

  @Test func ranksByCpuThenMemoryThenName() {
    let usage = MachineUsage(owners: [
      MachineOwner(kind: .shared, name: "b", cpuPercent: 5, residentMb: 10),
      MachineOwner(kind: .shared, name: "a", cpuPercent: 5, residentMb: 10),
      MachineOwner(kind: .build, name: "build", cpuPercent: 220, residentMb: 1960),
      MachineOwner(kind: .simulator, name: "sim", cpuPercent: 5, residentMb: 8000),
    ])
    #expect(usage.ranked.map(\.name) == ["build", "sim", "a", "b"])
    #expect(usage.cpuPercent == 235)
  }
}
