import Foundation
import Testing

@testable import StimKit

@Suite struct BuildMachinesTests {
  @Test func listsOnlyOtherMacsThatAreOnline() throws {
    let status = #"""
      {"BackendState":"Running","Self":{"ID":"nSelf","OS":"macOS","DNSName":"laptop.tail1.ts.net.","Online":true},
       "Peer":{
        "a":{"ID":"nMini","HostName":"Mac mini","DNSName":"Mini.tail1.ts.net.","OS":"macOS","Online":true},
        "b":{"ID":"nOff","HostName":"old","DNSName":"old.tail1.ts.net.","OS":"macOS","Online":false},
        "c":{"ID":"nPhone","HostName":"localhost","DNSName":"iphone.tail1.ts.net.","OS":"iOS","Online":true},
        "d":{"ID":"nFunnel","HostName":"funnel-ingress-node","DNSName":"","Online":true}}}
      """#
    let macs = try #require(Tailnet.macs(statusJSON: Data(status.utf8)))
    #expect(macs == [TailnetMac(id: "nMini", hostName: "Mac mini", dnsName: "mini.tail1.ts.net")])
    #expect(macs.first?.machine == "mini")
    #expect(Tailnet.macs(statusJSON: Data(#"{"BackendState":"Stopped"}"#.utf8)) == nil)
  }

  @Test func readsPlacementsFromStatsAndSplitsThemByMachine() throws {
    let stats = try JSONDecoder().decode(
      MachineStats.self,
      from: Data(
        #"""
        {"version":1,"project":null,"machine":{"ios":null,"android":null},"offload":{
          "today":{"here":1,"offloaded":1,"fellBack":1},
          "machines":{"mini":{"today":{"offloaded":1,"offloadedMs":200000,"savedMs":90000,"fallbacks":1},
                              "total":{"offloaded":4,"offloadedMs":800000,"savedMs":-5000,"fallbacks":2}}},
          "placements":[
            {"at":"2026-09-30T12:03:00.000Z","project":"/r/app","platform":"ios","decision":"fell-back","machine":"mini","reason":"mini: busy"},
            {"at":"2026-09-30T12:02:00.000Z","project":"/r/app","platform":"ios","decision":"offloaded","machine":"mini","reason":"this Mac is busy","buildMs":200000,"localEstimateMs":290000},
            {"at":"2026-09-30T12:01:00.000Z","project":"/r/app","platform":"android","decision":"here","reason":"load 0.6/core here","failed":true},
            {"at":"2026-09-30T12:00:00.000Z","project":"/r/app","platform":"ios","decision":"teleported","reason":"?"}]}}
        """#.utf8))
    let offload = try #require(stats.offload)
    #expect(offload.machines["mini"]?.total.savedMs == -5000)
    #expect(offload.placements(for: "mini").map(\.title) == ["Built here after mini", "Built on mini"])
    #expect(offload.here.map(\.failed) == [true])
    #expect(offload.placements.last?.decision == .unknown)
    let fellBack = try JSONDecoder().decode(
      BuildPlacements.Placement.self,
      from: Data(#"{"at":"x","project":"/p","platform":"ios","decision":"fell-back","reason":"git"}"#.utf8))
    #expect(fellBack.title == "Built here after offloading")
    let ported = try JSONDecoder().decode(
      BuildPlacements.Placement.self,
      from: Data(#"{"at":"x","project":"/p","platform":"ios","decision":"offloaded","machine":"mini:7444","reason":"r"}"#.utf8))
    #expect(ported.title == "Built on mini")
    #expect(try JSONDecoder().decode(MachineStats.self, from: Data(#"{"version":1}"#.utf8)).offload == nil)
  }

  @Test func describesOnlyTheCapacityAMachineReported() throws {
    let full = try JSONDecoder().decode(
      BuildMachineStatus.Capacity.self,
      from: Data(#"{"loadPerCore":0.3,"maxLoadPerCore":2,"cpus":10,"running":0,"max":1,"diskFreeBytes":812e9}"#.utf8))
    #expect(full.line == "load 0.3/core of 2 \u{00B7} 10 cores \u{00B7} 0 of 1 offloaded builds \u{00B7} 812 GB free")
    let old = try JSONDecoder().decode(BuildMachineStatus.Capacity.self, from: Data(#"{"loadPerCore":1.5}"#.utf8))
    #expect(old.line == "load 1.5/core")
  }

  @Test func readsEachMachineStateFromDoctorAndToleratesNewOnes() throws {
    let report = try JSONDecoder().decode(
      DoctorReport.self,
      from: Data(
        #"""
        {"project":"/p","findings":[],"buildMachines":[
          {"machine":"mini","state":"pending","dnsName":"mini.tail1.ts.net","deviceId":"ab12","requestedAt":"2026-09-28T12:00:00.000Z"},
          {"machine":"old:7444","state":"node-changed"},{"machine":"x","state":"from-the-future"}]}
        """#.utf8))
    let machines = try #require(report.buildMachines)
    #expect(machines.map(\.state) == [.pending, .nodeChanged, .unknown])
    #expect(machines[0].detail.contains("stim-server devices grant ab12 --build"))
    #expect(
      try JSONDecoder().decode(DoctorReport.self, from: Data(#"{"project":"/p","findings":[]}"#.utf8))
        .buildMachines == nil)
  }

  @Test func readsReadinessAsReadyOrTheFirstReasonWithItsRemedy() throws {
    let url = try #require(Bundle.module.url(forResource: "doctor", withExtension: "json", subdirectory: "Fixtures"))
    let machines = try #require(try JSONDecoder().decode(DoctorReport.self, from: Data(contentsOf: url)).buildMachines)
    #expect(
      machines.map(\.readiness.line) == [
        "Ready", "Busy (load 8.2/core)", "Stim build differs \u{2014} update the build machine",
      ])
    #expect(machines.map(\.readiness.tone) == [.success, .warning, .error])
    #expect(machines[2].readiness.reasons == "Stim build 6bbe9103995f7eb6 there, e7749c9011f4d423 here")
    #expect(
      machines.map(\.detail) == [
        "Builds can run on this Mac.", "Builds stay on this Mac for now.", "Update the build machine.",
      ])
    let older = try JSONDecoder().decode(
      BuildMachineStatus.self,
      from: Data(#"{"machine":"mini","state":"approved","offloadable":false,"reasons":["CPU x86_64 there, arm64 here"]}"#.utf8))
    #expect(older.readiness.line == "CPU x86_64 there, arm64 here")
    #expect(BuildMachineStatus(machine: "mini", state: .pending).readiness.line == "Waiting for approval")
  }

  @Test func editsTheSettingAndUnsetsItWhenEmpty() {
    #expect(OffloadMachines.adding("mini", to: ["studio:7444"]) == #"["studio:7444","mini"]"#)
    #expect(OffloadMachines.adding("mini", to: ["mini"]) == #"["mini"]"#)
    #expect(OffloadMachines.removing("studio:7444", from: ["studio:7444", "mini"]) == #"["mini"]"#)
    #expect(OffloadMachines.removing("mini", from: ["mini"]) == nil)
    let mini = TailnetMac(id: "n", hostName: "Mac mini", dnsName: "mini.tail1.ts.net")
    #expect(OffloadMachines.names("Mini:7444", mini) && OffloadMachines.names("mini.tail1.ts.net", mini))
    #expect(!OffloadMachines.names("minimal", mini))
  }

  @Test func separatesBuildClientsFromPhones() throws {
    let devices = try StimServerCLI.decoder.decode(
      PairedDeviceList.self,
      from: Data(
        #"""
        {"devices":[
          {"id":"p1","name":"iPhone","identity":{"kind":"tailnet","nodeName":"iphone"},"pairedAt":"2026-09-28T12:00:00.000Z","capabilities":["read"]},
          {"id":"b1","name":"laptop","identity":{"kind":"tailnet","nodeName":"laptop.tail1.ts.net","nodeId":"nL"},"pairedAt":"2026-09-28T12:00:00.000Z","capabilities":[],"pendingUntil":"2026-09-28T12:15:00.000Z"},
          {"id":"b2","name":"studio","identity":{"kind":"tailnet","nodeName":"studio"},"pairedAt":"2026-09-28T12:00:00.000Z","capabilities":["build"]}]}
        """#.utf8)
    ).devices
    #expect(devices.map(\.isBuildClient) == [false, true, true])
    #expect(devices[1].pendingUntil != nil && devices[2].pendingUntil == nil)
  }

  @Test func keepsABuildRequestTargetInTheInbox() throws {
    let target = OversightTarget.buildRequest(id: "ab12")
    let decoded = try JSONDecoder().decode(OversightTarget.self, from: JSONEncoder().encode(target))
    #expect(decoded == target && decoded.path == nil)
  }
}
