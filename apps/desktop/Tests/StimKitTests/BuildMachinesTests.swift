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
    #expect(try JSONDecoder().decode(DoctorReport.self, from: Data(#"{"project":"/p","findings":[]}"#.utf8))
      .buildMachines == nil)
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
