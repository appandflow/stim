import Foundation
import Testing

@testable import StimKit

@Suite struct PhysicalScreenTests {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  let open = ServerLink.open(desktopApi: 1, capabilities: ["read", "control"])

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
    let readOnly = ServerLink.open(desktopApi: 1, capabilities: ["read"])
    #expect(
      PhysicalScreen(device: try phone("android"), link: readOnly, now: now)
        == .stream(control: "Stim Desktop's stim-server pairing is read only."))
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
    let relaying = ServerLink.open(desktopApi: 1, capabilities: ["read", "control"])
    #expect(PhysicalScreen(hostedMacosOn: relaying).canControl)
    let readOnly = ServerLink.open(desktopApi: 1, capabilities: ["read"])
    #expect(
      PhysicalScreen(hostedMacosOn: readOnly) == .stream(control: "Stim Desktop's stim-server pairing is read only."))

  }

  func simulator(state: String, host: String? = nil) throws -> DeviceRef {
    let hostJSON = host.map { #","host":{"machine":"\#($0)","session":"s1"}"# } ?? ""
    let json = #"{"name":"stim-app (iPhone 17 27.0)","udid":"U1","owned":true,"state":"\#(state)"\#(hostJSON)}"#
    return .ios(slot: DeviceRef.defaultSlot, try JSONDecoder().decode(IosDevice.self, from: Data(json.utf8)))
  }

  @Test func aPairedServersOwnSimulatorStreamsThroughItWithControlOnlyFromAControlPairing() throws {
    let booted = try simulator(state: "Booted")
    let control = ServerLink.open(desktopApi: 1, capabilities: ["read", "control"])
    let readOnly = ServerLink.open(desktopApi: 1, capabilities: ["read"])
    #expect(PhysicalScreen(pairedDevice: booted, server: "floco", link: control, now: now).canControl)
    #expect(
      PhysicalScreen(pairedDevice: booted, server: "floco", link: readOnly, now: now)
        == .stream(control: "floco lets this Mac view only."))
    #expect(
      PhysicalScreen(pairedDevice: try simulator(state: "Shutdown"), server: "floco", link: control, now: now)
        == .message("Not running on floco."))
  }

  @Test func aPairedServersDevicesOfferNoCommandToRunOnThisMac() throws {
    let control = ServerLink.open(desktopApi: 1, capabilities: ["read", "control"])
    #expect(
      PhysicalScreen(pairedDevice: try simulator(state: "stopped", host: "mini-2:7443"), server: "floco", link: control, now: now)
        == .message("The iOS session on mini-2 stopped."))
    #expect(
      PhysicalScreen(pairedDevice: try phone("android", expiresIn: -1), server: "floco", link: control, now: now)
        == .message("The workspace's lease on this device ended."))
    #expect(
      PhysicalScreen(pairedDevice: try phone("android", connection: "disconnected"), server: "floco", link: control, now: now)
        == .message("Not connected to floco."))

  }

  @Test func mapsKeysToTheProtocolsText() {
    #expect(physicalInputText(characters: "a", keyCode: 0) == "a")
    #expect(physicalInputText(characters: "\r", keyCode: 0x24) == "\n")
    #expect(physicalInputText(characters: "\t", keyCode: 0x30) == "\t")
    #expect(physicalInputText(characters: "\u{7F}", keyCode: 0x33) == "\u{8}")
    #expect(physicalInputText(characters: "\u{F702}", keyCode: 0x7B) == nil)
    #expect(physicalInputText(characters: "\u{E9}", keyCode: 0) == nil)
  }

  @Test func mapsKeysToKeysAndChordsOnlyWhenTheServerTakesThem() {
    func input(
      _ characters: String, _ keyCode: UInt16, command: Bool = false, control: Bool = false, option: Bool = false,
      shift: Bool = false, chords: Bool
    ) -> PhysicalKeyInput? {
      physicalKeyInput(
        characters: characters, charactersIgnoringModifiers: characters, keyCode: keyCode, command: command,
        control: control, option: option, shift: shift, chords: chords)
    }
    #expect(input("\u{F702}", 0x7B, chords: false) == .key("left", modifiers: []))
    #expect(input("\u{F702}", 0x7B, shift: true, chords: false) == nil)
    #expect(input("\u{F702}", 0x7B, shift: true, chords: true) == .key("left", modifiers: ["shift"]))
    #expect(input("\u{1B}", 0x35, chords: false) == .key("escape", modifiers: []))
    #expect(input("a", 0, chords: true) == .text("a"))
    #expect(input("a", 0, command: true, chords: false) == nil)
    #expect(input("a", 0, command: true, chords: true) == .key("a", modifiers: ["command"]))
    #expect(input("z", 6, command: true, shift: true, chords: true) == .key("z", modifiers: ["command", "shift"]))
    #expect(input("\t", 0x30, control: true, chords: true) == .key("tab", modifiers: ["control"]))
    #expect(input("\u{F704}", 0x7A, command: true, chords: true) == nil)
  }
}
