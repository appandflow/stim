import Foundation
import Testing

@testable import StimKit

@Suite struct HostedAndroidTests {
  func device(_ state: String = "ready", session: String = "host-session") throws -> AndroidDevice {
    let json = """
      {"name":"pixel_6 (API 30)","serial":"","owned":false,"physical":false,"state":"\(state)",
       "host":{"machine":"mini:7443","session":"\(session)","selected":"mini:7443",
               "device":{"name":"pixel_6 (API 30)","systemImage":"system-images;android-30;google_apis;arm64-v8a","api":30},
               "agent":{"driver":"none","setting":"hosting.agentDriver"}}}
      """
    return try JSONDecoder().decode(AndroidDevice.self, from: Data(json.utf8))
  }

  @Test func keepsHostedSlotsDistinctWithoutTreatingTheEmptySerialAsALocalEmulator() throws {
    let android = try device()
    let phone = DeviceRef.android(slot: "default", android)
    let tablet = DeviceRef.android(slot: "tablet", android)
    #expect(phone.id != tablet.id)
    #expect(phone.id != DeviceRef.android(slot: "default", try device(session: "replacement")).id)
    #expect(phone.localEmulatorSerial == nil)
    #expect(phone.activityKey == nil)
    #expect(phone.isRunning)
    #expect(phone.label == "pixel_6 (API 30)")
    #expect(phone.detail == "API 30")
    #expect(runCommand(for: tablet, cwd: "/w")?.arguments == ["android", "--slot", "tablet", "--remote", "mini:7443"])
    #expect(stopCommand(for: tablet, cwd: "/w").arguments == ["stop", "--slot", "tablet"])
    let local = DeviceRef.android(
      slot: "default", AndroidDevice(name: "stim-local", owned: true, physical: false, serial: "emulator-5554", state: "detected")
    )
    #expect(local.localEmulatorSerial == "emulator-5554")
  }

  @Test func distinguishesStoppedConnectingUnavailableAndReadOnlyHostedScreens() throws {
    let now = Date()
    let hosted = DeviceRef.android(slot: "tablet", try device())
    let open = ServerLink.open(features: ["android-hosted"], capabilities: ["read", "control"])
    #expect(PhysicalScreen(device: hosted, link: open, now: now).canControl)
    #expect(PhysicalScreen(device: hosted, link: .connecting, now: now) == .message("Connecting to stim-server"))
    #expect(PhysicalScreen(device: hosted, link: .unavailable("offline"), now: now) == .message("offline"))
    let readOnly = ServerLink.open(features: ["android-hosted"], capabilities: ["read"])
    #expect(
      PhysicalScreen(device: hosted, link: readOnly, now: now)
        == .stream(control: "Stim Desktop's stim-server pairing is read only."))
    #expect(!PhysicalScreen(device: hosted, link: .open(features: [], capabilities: ["control"]), now: now).canControl)
    let stopped = DeviceRef.android(slot: "tablet", try device("stopped"))
    #expect(!stopped.isRunning)
    #expect(
      PhysicalScreen(device: stopped, link: open, now: now)
        == .message("The Android session on mini stopped.", remedy: "stim android --remote mini:7443 --slot tablet"))
    let unverified = DeviceRef.android(slot: "tablet", try device("unverified"))
    #expect(!unverified.isRunning)
    #expect(PhysicalScreen(device: unverified, link: open, now: now).canControl)
  }

  @Test func aConflictingLocalSerialCannotTurnAHostedTileIntoALocalTarget() throws {
    var android = try device()
    android.serial = "emulator-5554"
    android.owned = true
    let hosted = DeviceRef.android(slot: "default", android)
    #expect(hosted.localEmulatorSerial == nil)
    #expect(hosted.activityKey == nil)
    #expect(runCommand(for: hosted, cwd: "/w")?.arguments == ["android", "--remote", "mini:7443"])
    let json = """
      {"environments":[{"path":"/w","live":true,"warnings":[],
        "android":{"name":"stim-local","serial":"emulator-5554","owned":true,"physical":false,"state":"ready",
          "host":{"machine":"mini","session":"host-session","device":null}}}]}
      """
    let status = try JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    #expect(status.owner(of: .emulator(serial: "emulator-5554")) == nil)
  }
}
