import Foundation
import Testing

@testable import StimKit

@Suite struct StimServerTests {
  @Test func decodesHealthWithEachTailscaleState() throws {
    let stopped = try StimServerCLI.decoder.decode(
      ServerHealth.self,
      from: Data(
        #"{"server":"stim-server","name":"Mac","version":"1.9.0","stim":"1.9.0","protocol":1,"stimHome":"/Users/me/.stim","tailscale":{"state":"not-running","backendState":"Stopped"}}"#
          .utf8))
    #expect(stopped.protocolVersion == 1 && stopped.stimHome == "/Users/me/.stim")
    #expect(!stopped.tailscale.isRunning)
    #expect(stopped.tailscale.summary == "Tailscale is not running (Stopped).")
    #expect(stopped.route == nil)
    let running = try StimServerCLI.decoder.decode(
      TailscaleState.self,
      from: Data(#"{"state":"running","dnsName":"mac.tail1.ts.net"}"#.utf8))
    #expect(running.isRunning && running.dnsName == "mac.tail1.ts.net")
  }

  @Test func recognizesTheDefaultHomeThroughSymlinks() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("home-\(UUID().uuidString)").path
    defer { try? FileManager.default.removeItem(atPath: home) }
    try FileManager.default.createDirectory(atPath: "\(home)/.stim", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(home)/link", withDestinationPath: "\(home)/.stim")
    func health(_ stimHome: String) throws -> ServerHealth {
      try StimServerCLI.decoder.decode(
        ServerHealth.self,
        from: Data(
          #"{"server":"stim-server","name":"Mac","version":"1","stim":"1","protocol":1,"stimHome":"\#(stimHome)","tailscale":{"state":"running"}}"#
            .utf8))
    }
    #expect(try health("\(home)/.stim").servesDefaultHome(home: home))
    #expect(try health("\(home)/link").servesDefaultHome(home: home))
    #expect(try !health("\(home)/scratch/stimhome").servesDefaultHome(home: home))
  }

  @Test func namesTheEndpointAndSetupCommandOfEachRoute() throws {
    func route(_ json: String) throws -> ServeRoute {
      try StimServerCLI.decoder.decode(ServeRoute.self, from: Data(json.utf8))
    }
    #expect(try route(#"{"state":"routed","port":443}"#).endpoint(dnsName: "mac.ts.net") == "wss://mac.ts.net")
    #expect(try route(#"{"state":"routed","port":7443}"#).endpoint(dnsName: "mac.ts.net") == "wss://mac.ts.net:7443")
    let funneled = try route(#"{"state":"funneled","ports":[443],"port":7443}"#)
    #expect(funneled.ports == [443])
    #expect(funneled.setupCommand(serverPort: 7787) == "tailscale serve --bg --https=7443 http://127.0.0.1:7787")
  }

  @Test func encodesTheQRPayloadThePhoneParses() throws {
    let code = try StimServerCLI.decoder.decode(
      PairingCode.self,
      from: Data(
        #"{"qr":{"v":1,"name":"Mac","endpoint":"ws://127.0.0.1:7787","pairingToken":"abc_-1"},"expiresAt":"2026-09-25T05:58:15.563Z"}"#
          .utf8))
    #expect(code.isLocalOnly)
    #expect(code.expiresAt == ISO8601DateFormatter().date(from: "2026-09-25T05:58:15Z")!.addingTimeInterval(0.563))
    let qr = try JSONSerialization.jsonObject(with: Data(code.qrText.utf8)) as? [String: Any]
    #expect(qr?["v"] as? Int == 1)
    #expect(qr?["endpoint"] as? String == "ws://127.0.0.1:7787")
    #expect(qr?["pairingToken"] as? String == "abc_-1")
    #expect(qr?["name"] as? String == "Mac")
  }

  @Test func describesTheNodeADevicePairedFrom() throws {
    let devices = try StimServerCLI.decoder.decode(
      PairedDeviceList.self,
      from: Data(
        #"""
        {"devices":[
          {"id":"a1","name":"Phone","identity":{"kind":"tailnet","nodeId":"n1","nodeName":"phone.tail1.ts.net","user":"janic@example.com"},"pairedAt":"2026-09-25T05:00:00.000Z","lastSeenAt":null,"capabilities":["read"]},
          {"id":"b2","name":"Sim","identity":{"kind":"local"},"pairedAt":"2026-09-25T05:00:00.000Z","lastSeenAt":"2026-09-25T06:00:00.000Z","capabilities":["read","control"]}
        ]}
        """#.utf8)
    ).devices
    #expect(devices.map(\.node) == ["phone.tail1.ts.net (janic@example.com)", "This Mac"])
    #expect(devices[0].lastSeenAt == nil && devices[1].lastSeenAt != nil)
    #expect(devices.map(\.canControl) == [false, true])
  }
}
