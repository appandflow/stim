import Foundation
import Testing

@testable import StimKit

@Suite struct StimHomeTests {
  @Test func launchHomeOverridesShellHome() {
    let environment = StimHome.environment(
      ["STIM_HOME": "/tmp/shell", "PATH": "/bin"], launch: ["STIM_HOME": "/tmp/launch"])
    #expect(environment["STIM_HOME"] == "/tmp/launch")
    #expect(environment["PATH"] == "/bin")
    #expect(StimHome.path(environment: environment) == "/tmp/launch")
  }

  @Test(arguments: [[:], ["STIM_HOME": ""], ["STIM_HOME": "relative/x"], ["STIM_HOME": "~/x"]])
  func absentOrEmptyLaunchHomeKeepsShellHome(launch: [String: String]) {
    let environment = StimHome.environment(["STIM_HOME": "/tmp/shell"], launch: launch)
    #expect(StimHome.path(environment: environment) == "/tmp/shell")
  }

  @Test func defaultHomeDoesNotSetEnvironmentVariable() {
    let environment = StimHome.environment(["PATH": "/bin"], launch: [:])
    #expect(environment["STIM_HOME"] == nil)
    #expect(StimHome.path(environment: environment, home: "/Users/me") == "/Users/me/.stim")
    #expect(StimHome.path(environment: ["STIM_HOME": ""], home: "/Users/me") == "/Users/me/.stim")
    #expect(StimHome.path(environment: ["STIM_HOME": "relative"], home: "/Users/me") == "/Users/me/.stim")
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
