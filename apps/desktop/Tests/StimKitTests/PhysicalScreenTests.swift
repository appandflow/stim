import Foundation
import Testing

@testable import StimKit

@Suite struct PhysicalScreenTests {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  let open = ServerLink.open(features: ["physical-ios", "physical-android"], capabilities: ["read", "control"])

  func phone(_ platform: String, connection: String = "connected", expiresIn: TimeInterval = 600) throws -> DeviceRef {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let expires = formatter.string(from: now.addingTimeInterval(expiresIn))
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
      "The stim-server on this port is older than Stim Desktop and cannot show this device's screen. Update or stop it so Stim Desktop starts its own."
    )
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
      PhysicalScreen(device: try phone("android", connection: "disconnected"), link: .connecting, now: now)
        == .message("Disconnected. Plug the phone into this Mac and allow USB debugging."))
    #expect(
      PhysicalScreen(device: try phone("ios", connection: "unknown"), link: open, now: now)
        == .message("Stim cannot tell whether this device is connected."))
  }

  @Test func showsAHostedMacosAppOnlyThroughAServerThatRelaysIt() {
    let relaying = ServerLink.open(features: ["macos-window", "macos-hosted"], capabilities: ["read", "control"])
    #expect(PhysicalScreen(hostedMacosOn: relaying).canControl)
    let readOnly = ServerLink.open(features: ["macos-hosted"], capabilities: ["read"])
    #expect(
      PhysicalScreen(hostedMacosOn: readOnly) == .stream(control: "Stim Desktop's stim-server pairing is read only."))
    let older = ServerLink.open(features: ["macos-window"], capabilities: ["read", "control"])
    #expect(
      PhysicalScreen(hostedMacosOn: older)
        == .message(
          "The stim-server on this port is older than Stim Desktop and cannot show this app's window. Update or stop it so Stim Desktop starts its own."
        ))
  }

  func simulator(state: String, host: String? = nil) throws -> DeviceRef {
    let hostJSON = host.map { #","host":{"machine":"\#($0)","session":"s1"}"# } ?? ""
    let json = #"{"name":"stim-app (iPhone 17 27.0)","udid":"U1","owned":true,"state":"\#(state)"\#(hostJSON)}"#
    return .ios(slot: DeviceRef.defaultSlot, try JSONDecoder().decode(IosDevice.self, from: Data(json.utf8)))
  }

  @Test func aPairedServersOwnSimulatorStreamsThroughItWithControlOnlyFromAControlPairing() throws {
    let booted = try simulator(state: "Booted")
    let control = ServerLink.open(features: [], capabilities: ["read", "control"])
    let readOnly = ServerLink.open(features: [], capabilities: ["read"])
    #expect(PhysicalScreen(pairedDevice: booted, server: "floco", link: control, now: now).canControl)
    #expect(
      PhysicalScreen(pairedDevice: booted, server: "floco", link: readOnly, now: now)
        == .stream(control: "floco lets this Mac view only."))
    #expect(
      PhysicalScreen(pairedDevice: try simulator(state: "Shutdown"), server: "floco", link: control, now: now)
        == .message("Not running on floco."))
  }

  @Test func aPairedServersDevicesOfferNoCommandToRunOnThisMac() throws {
    let control = ServerLink.open(features: ["ios-hosted", "physical-android"], capabilities: ["read", "control"])
    #expect(
      PhysicalScreen(pairedDevice: try simulator(state: "stopped", host: "mini-2:7443"), server: "floco", link: control, now: now)
        == .message("The iOS session on mini-2 stopped."))
    #expect(
      PhysicalScreen(pairedDevice: try phone("android", expiresIn: -1), server: "floco", link: control, now: now)
        == .message("The workspace's lease on this device ended."))
    #expect(
      PhysicalScreen(pairedDevice: try phone("android", connection: "disconnected"), server: "floco", link: control, now: now)
        == .message("Not connected to floco."))
    #expect(
      PhysicalScreen(pairedDevice: try simulator(state: "ready", host: "mini-2:7443"), server: "floco", link: open, now: now)
        == .message("Update stim-server on floco to show this device's screen."))
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
