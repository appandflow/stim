import Foundation
import Testing

@testable import StimKit

@Suite struct DeviceTileStatusTests {
  func ios(state: String, name: String? = "stim-app (iPhone 17 27.0)", host: String? = nil, physical: Bool = false) throws
    -> DeviceRef
  {
    let hostJSON = host.map { #","host":{"machine":"\#($0)","session":"s1"}"# } ?? ""
    let nameJSON = name.map { #""\#($0)""# } ?? "null"
    let json = #"{"name":\#(nameJSON),"udid":"U1","owned":true,"state":"\#(state)"\#(hostJSON)}"#
    var device = try JSONDecoder().decode(IosDevice.self, from: Data(json.utf8))
    device.physical = physical
    return .ios(slot: DeviceRef.defaultSlot, device)
  }

  @Test func aShutDownDeviceOffersNoHeaderActionWhetherOrNotItIsControllable() throws {
    for canControl in [true, false] {
      let status = DeviceTileStatus(device: try ios(state: "Shutdown"), canControl: canControl, building: false)
      #expect(status.phase == .shutDown)
      #expect(status.headerAction == nil)
      #expect(status.message == nil)
    }
  }

  @Test func aBootingDeviceShowsProgressAndNoAction() throws {
    let status = DeviceTileStatus(device: try ios(state: "Booting"), canControl: true, building: false)
    #expect(status.phase == .booting)
    #expect(status.showsProgress)
    #expect(status.message == "Booting simulator")
    #expect(status.headerAction == nil)
  }

  @Test func aDeviceWaitingOnItsBuildOffersNoAction() throws {
    let status = DeviceTileStatus(device: try ios(state: "Shutdown"), canControl: true, building: true)
    #expect(status.phase == .booting)
    #expect(status.headerAction == nil)
  }

  @Test func aLiveDeviceOffersControlOrView() throws {
    let booted = try ios(state: "Booted")
    #expect(DeviceTileStatus(device: booted, canControl: true, building: false).headerAction == .control)
    #expect(DeviceTileStatus(device: booted, canControl: false, building: false).headerAction == .view)
    #expect(DeviceTileStatus(device: booted, canControl: true, building: false).phase == .live)
  }

  @Test func aStartingHostedSessionReadsAsStartingAndOffersNoAction() throws {
    let device = try ios(state: "unverified", name: nil, host: "janics-mac-mini")
    #expect(device.label == "iOS Simulator")
    let status = DeviceTileStatus(device: device, canControl: true, building: true)
    #expect(status.phase == .hostedStarting)
    #expect(status.message == "Starting simulator on janics-mac-mini")
    #expect(status.showsProgress)
    #expect(status.headerAction == nil)
  }

  @Test func aReadyHostedSessionIsLive() throws {
    let device = try ios(state: "ready", name: nil, host: "janics-mac-mini")
    let status = DeviceTileStatus(device: device, canControl: true, building: true)
    #expect(status.phase == .live)
    #expect(status.headerAction == .control)
    #expect(status.message == nil)
  }

  @Test func anUnconfirmedHostedSessionWithoutABuildHasFailed() throws {
    for state in ["unverified", "unknown", "unreachable"] {
      let status = DeviceTileStatus(
        device: try ios(state: state, name: nil, host: "janics-mac-mini"), canControl: true, building: false)
      #expect(status.phase == .hostedFailed)
      #expect(status.message == "Cannot confirm the simulator on janics-mac-mini")
      #expect(!status.showsProgress)
      #expect(status.headerAction == nil)
    }
  }

  @Test func aStoppedHostedSessionIsShutDown() throws {
    let status = DeviceTileStatus(
      device: try ios(state: "stopped", name: nil, host: "janics-mac-mini"), canControl: false, building: false)
    #expect(status.phase == .shutDown)
    #expect(status.headerAction == nil)
  }

  @Test func aMissingSimulatorIsReportedAsGone() throws {
    let device = try ios(state: "missing", name: nil)
    let status = DeviceTileStatus(device: device, canControl: false, building: false)
    #expect(status.phase == .missing)
    #expect(status.message == "The simulator no longer exists.")
    #expect(status.headerAction == nil)
  }

  @Test func aDisconnectedPhysicalDeviceStillOpensItsViewer() throws {
    let status = DeviceTileStatus(
      device: try ios(state: "disconnected", physical: true), canControl: false, building: false)
    #expect(status.phase == .disconnected)
    #expect(status.headerAction == .view)
  }

  @Test func theEstimateShowsOnlyWhileTheRunIsWithinIt() {
    #expect(Format.estimateSuffix(elapsedMs: 30_000, expectedMs: 49_000) == " / ~0:49")
    #expect(Format.estimateSuffix(elapsedMs: 49_000, expectedMs: 49_000) == " / ~0:49")
    #expect(Format.estimateSuffix(elapsedMs: 63_000, expectedMs: 49_000) == "")
    #expect(Format.estimateSuffix(elapsedMs: 10_000, expectedMs: nil) == "")
  }

  @Test func everyPlatformMapsTheSameStatesToTheSameStatusAndActions() {
    for platform in ["ios", "android", "macos", "web"] {
      let noun = ["android": "emulator", "macos": "app", "web": "page"][platform] ?? "simulator"
      func status(_ state: String, host: String? = nil, running: Bool = false, building: Bool = false) -> DeviceTileStatus {
        DeviceTileStatus(
          platform: platform, hostedMachine: host, state: state, isRunning: running, canControl: true, building: building)
      }
      #expect(status("stopped").phase == .shutDown)
      #expect(status("stopped").headerAction == nil)
      #expect(status("Booting").message == "Booting \(noun)")
      #expect(status("x", building: true).phase == .booting)
      #expect(status("detected", running: true).headerAction == .control)
      #expect(status("ready", host: "mini", running: true).headerAction == .control)
      let starting = status("unverified", host: "mini", building: true)
      #expect(starting.message == "Starting \(noun) on mini")
      #expect(starting.showsProgress && starting.headerAction == nil)
      let failed = status("unreachable", host: "mini")
      #expect(failed.phase == .hostedFailed && failed.message == "Cannot confirm the \(noun) on mini")
      #expect(failed.headerAction == nil)
      let missing = status("missing")
      #expect(missing.phase == .missing && missing.message == "The \(noun) no longer exists.")
      #expect(missing.headerAction == nil)
    }
  }
}
