import Foundation
import Testing

@testable import StimKit

@Suite struct StimHomeTests {
  @Test func launchHomeOverridesTheSettingAndTheDefaultHomeIsNeverExported() {
    let launch = Toolchain.settingsEnvironment(
      launch: ["STIM_HOME": "/tmp/launch", "PATH": "/bin"], stimHome: "/tmp/setting", overrides: nil, home: "/Users/me")
    #expect(launch["STIM_HOME"] == "/tmp/launch")
    #expect(launch["PATH"] == "/bin")
    let setting = Toolchain.settingsEnvironment(
      launch: ["STIM_HOME": "relative"], stimHome: "/tmp/setting", overrides: nil, home: "/Users/me")
    #expect(setting["STIM_HOME"] == "/tmp/setting")
    let tilde = Toolchain.settingsEnvironment(launch: [:], stimHome: "~/scratch", overrides: nil, home: "/Users/me")
    #expect(tilde["STIM_HOME"] == "/Users/me/scratch")
    let defaultHome = Toolchain.settingsEnvironment(
      launch: [:], stimHome: "/Users/me/.stim", overrides: "STIM_HOME=/Users/me/.stim", home: "/Users/me")
    #expect(defaultHome["STIM_HOME"] == nil)
    #expect(StimHome.path(environment: defaultHome, home: "/Users/me") == "/Users/me/.stim")
  }

  @Test func overridesSetVariablesAndSkipCommentsAndInvalidNames() {
    let environment = Toolchain.settingsEnvironment(
      launch: ["NODE_USE_SYSTEM_CA": "1"],
      stimHome: nil,
      overrides: "# trustd stall\nNODE_USE_SYSTEM_CA=0\n  STIM_MAX_BUILDS = 2\nnot a line\n1BAD=x\nURL=a=b\n",
      home: "/Users/me")
    #expect(environment["NODE_USE_SYSTEM_CA"] == "0")
    #expect(environment["STIM_MAX_BUILDS"] == " 2")
    #expect(environment["URL"] == "a=b")
    #expect(environment["1BAD"] == nil)
  }

  @Test func defaultDesktopStillAdoptsForeignServer() {
    #expect(StimHome.adopts(serverHome: "/tmp/foreign", resolved: "/Users/me/.stim", home: "/Users/me"))
    #expect(
      StimHome.adoptionFailure(
        serverHome: "/tmp/foreign", resolved: "/Users/me/.stim", port: 7787, home: "/Users/me") == nil)
  }

  @Test(arguments: ["/tmp/other", "/tmp/private/child", "/tmp/private-other"])
  func privateHomeRejectsDifferentServerHome(serverHome: String) {
    #expect(!StimHome.adopts(serverHome: serverHome, resolved: "/tmp/private", home: "/Users/me"))
  }

  @Test func canonicalHomesMatchThroughSymlinks() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("home-\(UUID().uuidString)").path
    defer { try? FileManager.default.removeItem(atPath: home) }
    try FileManager.default.createDirectory(atPath: "\(home)/state", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(home)/.stim", withDestinationPath: "\(home)/state")
    #expect(StimHome.isDefault("\(home)/state", home: home))
    #expect(!StimHome.isDefault("\(home)/state/child", home: home))
    try FileManager.default.createDirectory(atPath: "\(home)/private", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(home)/link", withDestinationPath: "\(home)/private")
    #expect(StimHome.adopts(serverHome: "\(home)/link", resolved: "\(home)/private", home: home))
  }

  @Test func refusalNamesBothHomesAndPort() throws {
    let message = try #require(
      StimHome.adoptionFailure(
        serverHome: "/Users/me/.stim", resolved: "/Users/me/private", port: 7790, home: "/Users/me"))
    #expect(message.contains("7790"))
    #expect(message.contains("~/.stim"))
    #expect(message.contains("~/private"))
  }
}
