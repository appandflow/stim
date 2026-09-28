import Foundation
import Testing

@testable import StimKit

@Suite struct PhysicalScreenTests {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  let open = ServerLink.open(features: ["physical-ios", "physical-android"], capabilities: ["read", "control"])

  func phone(_ platform: String, connection: String = "connected", expiresIn: TimeInterval = 600) throws -> DeviceRef {
    let expires = ISO8601DateFormatter().string(from: now.addingTimeInterval(expiresIn))
    let json = """
      {"platform":"\(platform)","slot":"default","id":"R5","name":"Galaxy","model":null,"owned":false,"physical":true,
       "connection":"\(connection)","lease":{"holder":"/w","kind":"run","grantedAt":null,"expiresAt":"\(expires)"}}
      """
    return try JSONDecoder().decode(PhysicalDevice.self, from: Data(json.utf8)).ref
  }

  @Test func offersControlOnlyForAnAndroidPhoneOverAControlPairing() throws {
    #expect(PhysicalScreen(device: try phone("android"), link: open, now: now).canControl)
    #expect(
      PhysicalScreen(device: try phone("ios"), link: open, now: now)
        == .stream(control: "stim-server shows an iPhone's screen but does not drive it."))
    let readOnly = ServerLink.open(features: ["physical-android"], capabilities: ["read"])
    #expect(
      PhysicalScreen(device: try phone("android"), link: readOnly, now: now)
        == .stream(control: "Stim Desktop's stim-server pairing is read only."))
  }

  @Test func asksForANewerServerWithoutThePlatformsFeature() throws {
    let update = PhysicalScreen.message(
      "Update stim-server to see this device's screen.", remedy: "npm install --global @stim-cli/server@latest")
    let older = ServerLink.open(features: nil, capabilities: ["read", "control"])
    #expect(PhysicalScreen(device: try phone("android"), link: older, now: now) == update)
    let iosOnly = ServerLink.open(features: ["physical-ios"], capabilities: ["read", "control"])
    #expect(PhysicalScreen(device: try phone("android"), link: iosOnly, now: now) == update)
    #expect(PhysicalScreen(device: try phone("ios"), link: iosOnly, now: now).canControl == false)
  }

  @Test func stopsStreamingOnceTheLeaseEndsBeforeStatusDropsTheDevice() throws {
    #expect(
      PhysicalScreen(device: try phone("android", expiresIn: -1), link: open, now: now)
        == .message("The workspace's lease on this device ended.", remedy: "stim android --device"))
  }

  @Test func namesADisconnectedPhoneBeforeTheServerState() throws {
    #expect(
      PhysicalScreen(device: try phone("android", connection: "disconnected"), link: .off, now: now)
        == .message("Disconnected. Plug the phone into this Mac and allow USB debugging."))
    #expect(
      PhysicalScreen(device: try phone("ios", connection: "unknown"), link: open, now: now)
        == .message("Stim cannot tell whether this device is connected."))
  }

  @Test func mapsKeysToTheProtocolsText() {
    #expect(physicalInputText(characters: "a", keyCode: 0) == "a")
    #expect(physicalInputText(characters: "\r", keyCode: 0x24) == "\n")
    #expect(physicalInputText(characters: "\t", keyCode: 0x30) == "\t")
    #expect(physicalInputText(characters: "\u{7F}", keyCode: 0x33) == "\u{8}")
    #expect(physicalInputText(characters: "\u{F702}", keyCode: 0x7B) == nil)
    #expect(physicalInputText(characters: "\u{E9}", keyCode: 0) == nil)
  }
}
