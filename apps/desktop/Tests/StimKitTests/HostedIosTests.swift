import Foundation
import Testing

@testable import StimKit

@Suite struct HostedIosTests {
  func device(_ state: String = "ready", session: String = "host-session") throws -> IosDevice {
    let json = """
      {"name":"stim-app (iPhone 17 Pro 27.0)","udid":"","owned":false,"state":"\(state)",
       "host":{"machine":"mini:7443","session":"\(session)","selected":"mini:7443",
               "device":{"name":"iPhone 17 Pro","runtime":"iOS 27.0"},
               "agent":{"driver":"none","setting":"hosting.agentDriver"}}}
      """
    return try JSONDecoder().decode(IosDevice.self, from: Data(json.utf8))
  }

  @Test func keepsHostedSlotsDistinctWithoutTreatingTheEmptyUdidAsALocalSimulator() throws {
    let ios = try device()
    let phone = DeviceRef.ios(slot: "default", ios)
    let tablet = DeviceRef.ios(slot: "tablet", ios)
    #expect(phone.id != tablet.id)
    #expect(phone.id != DeviceRef.ios(slot: "default", try device(session: "replacement")).id)
    #expect(phone.localSimulatorUDID == nil)
    #expect(phone.activityKey == nil)
    #expect(phone.isRunning)
    #expect(phone.label == "iPhone 17 Pro")
    #expect(phone.detail == "iOS 27.0")
    #expect(runCommand(for: tablet, cwd: "/w")?.arguments == ["ios", "--slot", "tablet", "--remote", "mini:7443"])
    #expect(stopCommand(for: tablet, cwd: "/w").arguments == ["stop", "--slot", "tablet"])
    let local = DeviceRef.ios(slot: "default", IosDevice(name: "iPhone", udid: "local", owned: true, state: "Booted"))
    #expect(local.localSimulatorUDID == "local")
  }

  @Test func distinguishesStoppedConnectingUnavailableAndReadOnlyHostedScreens() throws {
    let now = Date()
    let hosted = DeviceRef.ios(slot: "tablet", try device())
    let open = ServerLink.open(features: ["ios-hosted"], capabilities: ["read", "control"])
    #expect(PhysicalScreen(device: hosted, link: open, now: now).canControl)
    #expect(PhysicalScreen(device: hosted, link: .connecting, now: now) == .message("Connecting to stim-server"))
    #expect(PhysicalScreen(device: hosted, link: .unavailable("offline"), now: now) == .message("offline"))
    let readOnly = ServerLink.open(features: ["ios-hosted"], capabilities: ["read"])
    #expect(
      PhysicalScreen(device: hosted, link: readOnly, now: now)
        == .stream(control: "Stim Desktop's stim-server pairing is read only."))
    #expect(!PhysicalScreen(device: hosted, link: .open(features: [], capabilities: ["control"]), now: now).canControl)
    let stopped = DeviceRef.ios(slot: "tablet", try device("stopped"))
    #expect(!stopped.isRunning)
    #expect(
      PhysicalScreen(device: stopped, link: open, now: now)
        == .message("The iOS session on mini stopped.", remedy: "stim ios --remote mini:7443 --slot tablet"))
    let unverified = DeviceRef.ios(slot: "tablet", try device("unverified"))
    #expect(!unverified.isRunning)
    #expect(PhysicalScreen(device: unverified, link: open, now: now).canControl)
  }
}
