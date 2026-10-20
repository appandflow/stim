import Foundation
import Testing

@testable import StimKit

@Suite struct StimHomeTests {
  @Test func localSocketsMatchTheServerForLongHostedAndUnicodeHomes() {
    #expect(StimHome.localSocket(home: "/tmp/short").path == "/tmp/short/server/local.sock")
    let boundary = "/tmp/" + String(repeating: "a", count: 80)
    #expect(StimHome.localSocket(home: boundary).path == boundary + "/server/local.sock")
    #expect(StimHome.localSocket(home: boundary).path.utf8.count == 103)
    #expect(StimHome.localSocket(home: boundary + "a").path != boundary + "a/server/local.sock")
    let hosted = StimHome.localSocket(
      home: "/Users/desktop-test/.stim/device-host/sessions/00000000-0000-0000-0000-000000000001/home")
    #expect(hosted.path == "/tmp/stim-sockets-\(getuid())/9f6edf71ce2641a80365d6ee1e38df37cebd7261304e96694ce1bc2053ab1267.sock")
    let unicode = StimHome.localSocket(home: "/tmp/" + String(repeating: "\u{00e9}", count: 45))
    #expect(unicode.path == "/tmp/stim-sockets-\(getuid())/46b20e2924d77e53740dfa2db4d94ffaf8ea79ce0ee1dae0ac77a566b2f16748.sock")
    #expect(unicode != hosted)
    #expect(unicode.path.utf8.count <= 103)
    #expect(StimHome.localSocket(home: "/tmp/./unused/../" + String(repeating: "\u{00e9}", count: 45)) == unicode)
  }

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
    #expect(environment["STIM_MAX_BUILDS"] == "2")
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
