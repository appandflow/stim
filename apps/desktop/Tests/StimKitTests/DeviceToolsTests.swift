import Foundation
import Testing

@testable import StimKit

@Suite struct DeviceToolsTests {
  @Test func buildsTheDeviceCommandsTheCLIAccepts() {
    #expect(
      DeviceTool.setLocation(latitude: -33.8688, longitude: 151.2093).arguments(platform: "ios", slot: "default")
        == ["device", "location", "ios", "--set", "-33.868800,151.209300", "--json"])
    #expect(
      DeviceTool.permission(.reset, service: "camera").arguments(platform: "android", slot: "second")
        == ["device", "permission", "android", "reset", "camera", "--slot", "second", "--json"])
    #expect(
      DeviceTool.network(enabled: false).arguments(platform: "android", slot: "default")
        == ["device", "network", "android", "off", "--json"])
    #expect(
      DeviceTool.push(payload: "{\"aps\":{}}").arguments(platform: "ios", slot: "default")
        == ["device", "push", "ios", "--payload", "{\"aps\":{}}", "--json"])
  }

  @Test func parsesCoordinatesLikeTheCLI() throws {
    let point = try #require(DeviceTool.parseCoordinate("45.5017, -73.5673"))
    #expect(point.latitude == 45.5017 && point.longitude == -73.5673)
    for text in ["", "45.5", "91, 0", "0, 181", "north, west", "1, 2, 3"] {
      #expect(DeviceTool.parseCoordinate(text) == nil)
    }
  }

  @Test func readsTheCLIPayloadsForTheStatusLine() throws {
    func decode(_ json: String) throws -> DeviceToolResult {
      try JSONDecoder().decode(DeviceToolResult.self, from: Data(json.utf8))
    }
    let granted = try decode(
      """
      {"platform":"android","slot":"default","deviceId":"emulator-5554","deviceName":"stim-a","tool":"permission",
       "action":"grant","service":"camera","appId":"com.example",
       "readBack":{"permissions":[{"name":"android.permission.CAMERA","granted":true}]}}
      """)
    #expect(granted.summary == "camera granted, as the device reports.")
    let mixed = try decode(
      """
      {"tool":"permission","action":"grant","service":"photos","deviceName":"a",
       "readBack":{"permissions":[{"name":"android.permission.READ_MEDIA_IMAGES","granted":true},
                                  {"name":"android.permission.READ_EXTERNAL_STORAGE","granted":false}]}}
      """)
    #expect(mixed.summary == "photos granted, as the device reports.")
    let ios = try decode(
      #"{"tool":"permission","action":"revoke","service":"photos","deviceName":"d","readBack":null}"#)
    #expect(ios.summary == "photos revoked.")
    let unread = try decode(
      """
      {"platform":"ios","slot":"default","deviceId":"U","deviceName":"stim-i","tool":"location","action":"set",
       "latitude":1,"longitude":2,"readBack":null}
      """)
    #expect(unread.readBack == nil)
    #expect(unread.summary == "Location set.")
    let network = try decode(
      """
      {"platform":"android","slot":"default","deviceId":"e","deviceName":"a","tool":"network","enabled":false,
       "readBack":{"wifi":false,"data":false}}
      """)
    #expect(network.summary == "Wi-Fi off, mobile data off, as the device reports.")
  }

  @Test func showsTheRefusalMessageAndRemedyWithoutTheCode() {
    let json = Data(
      #"{"code":"STIM_DEVICE_TOOL_FAILED","message":"simctl failed:\nline two","remedy":"Retry."}"#.utf8)
    #expect(DeviceToolError(stdout: json, stderr: "ignored").errorDescription == "simctl failed:\nline two Retry.")
    let old = DeviceToolError(stdout: Data(), stderr: "error: unknown command 'location'")
    #expect(old.errorDescription == "This version of stim has no device tools. Update stim to 1.30.0 or later.")
    let error = DeviceToolError(
      stdout: Data(),
      stderr: "STIM_DEVICE_TOOL_TARGET: The owned iOS simulator is not booted.\nRun `stim ios` to boot it.")
    #expect(error.errorDescription == "The owned iOS simulator is not booted. Run `stim ios` to boot it.")
  }
}
