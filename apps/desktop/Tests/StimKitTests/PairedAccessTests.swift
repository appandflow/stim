import Foundation
import Testing

@testable import StimKit

@Suite struct PairedAccessTests {
  func open(capabilities: [String], actions: String?) throws -> ServerClient.State {
    let actionsJSON = actions.map { #","actions":\#($0)"# } ?? ""
    let json = #"""
      {"protocol":2,"server":{"id":"f","name":"floco","version":"1","stim":"1"},
       "capabilities":\#(capabilities),"device":{"id":"d-1","name":"Mac"}\#(actionsJSON)}
      """#
    return .open(try JSONDecoder().decode(HelloResult.self, from: Data(json.utf8)))
  }

  @Test func offersOnlyTheKnownActionsAControlPairingAdvertises() throws {
    let state = try open(capabilities: ["read", "control"], actions: #"["stop","shell","reload"]"#)
    let access = PairedAccess(state: state, server: "floco", deviceID: "d-1")
    #expect(access.canControl)
    #expect(access.actions == ["reload", "stop"])
    #expect(access.reason == nil)
  }

  @Test func aReadPairingOffersNothingAndNamesTheGrantCommand() throws {
    let state = try open(capabilities: ["read"], actions: #"["reload","stop"]"#)
    let access = PairedAccess(state: state, server: "floco", deviceID: "d-1")
    #expect(access.actions.isEmpty)
    #expect(
      access.reason == "floco lets this Mac view only. On floco, run stim-server devices grant d-1 --control, then Reconnect.")
  }

  @Test func neverBuildsAGrantCommandFromADeviceIDThatIsNotPlain() throws {
    let state = try open(capabilities: ["read"], actions: "[]")
    let access = PairedAccess(state: state, server: "floco", deviceID: "d-1; rm -rf ~")
    #expect(
      access.reason
        == "floco lets this Mac view only. On floco, run stim-server devices grant <id> --control, then Reconnect.")
  }

  @Test func namesWhyNoActionIsOfferedWhenDisconnectedOrTheServerPredatesActions() throws {
    #expect(
      PairedAccess(state: .waiting(retryIn: 3, reason: "x"), server: "floco", deviceID: nil).reason
        == "Not connected to floco.")
    let older = PairedAccess(state: try open(capabilities: ["read", "control"], actions: nil), server: "floco", deviceID: nil)
    #expect(older.actions.isEmpty)
    #expect(older.reason == "Update stim-server on floco to run actions from Stim Desktop.")
  }
}
