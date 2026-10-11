import Foundation
import Testing

@testable import StimKit

@Suite struct ProvisionalServerStartTests {
  private final class Bins {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("stim-provisional-\(UUID().uuidString)")
    func server(in name: String) throws -> String {
      let dir = root.appendingPathComponent(name)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let path = dir.appendingPathComponent("stim-server").path
      FileManager.default.createFile(
        atPath: path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
      return path
    }
    func dir(_ name: String) -> String { root.appendingPathComponent(name).path }
    deinit { try? FileManager.default.removeItem(at: root) }
  }

  @Test func remembersOnlyNonSecretStimAndToolVariables() throws {
    let bins = Bins()
    let executable = try bins.server(in: "a")
    let login = [
      "PATH": "\(bins.dir("a")):/usr/bin", "STIM_HOME": "/tmp/home", "ANDROID_HOME": "/sdk", "JAVA_HOME": "/jdk",
      "EDITOR": "vim", "GITHUB_TOKEN": "ghp", "STIM_DESKTOP_APP": "/Applications/Stim.app",
      "STIM_RUN_ID": "run-1",
    ]
    let start = try #require(ProvisionalServerStart.remembering(environment: login, override: nil))
    #expect(start.executable == executable)
    #expect(
      start.environment == [
        "PATH": "\(bins.dir("a")):/usr/bin", "STIM_HOME": "/tmp/home", "ANDROID_HOME": "/sdk", "JAVA_HOME": "/jdk",
      ])

    var withSecret = login
    withSecret["STIM_KEYSTORE_PASSWORD"] = "hunter2"
    #expect(ProvisionalServerStart.remembering(environment: withSecret, override: nil) == nil)
    #expect(ProvisionalServerStart.remembering(environment: ["PATH": "/usr/bin"], override: nil) == nil)
  }

  @Test func startsOnlyWithTheRememberedExecutableAndTheLaunchHome() throws {
    let bins = Bins()
    let executable = try bins.server(in: "a")
    let other = try bins.server(in: "b")
    let start = ProvisionalServerStart(
      executable: executable, environment: ["PATH": bins.dir("a"), "STIM_HOME": "/tmp/cached"])
    let launch = ["PATH": "/usr/bin", "HOME": "/Users/me"]

    #expect(
      start.environment(launch: launch, override: nil)
        == ["PATH": bins.dir("a"), "STIM_HOME": "/tmp/cached", "HOME": "/Users/me"])
    #expect(
      start.environment(launch: launch.merging(["STIM_HOME": "/tmp/launch"]) { $1 }, override: nil)?["STIM_HOME"]
        == "/tmp/launch")
    #expect(start.environment(launch: launch, override: other) == nil)

    try FileManager.default.removeItem(atPath: executable)
    #expect(start.environment(launch: launch, override: nil) == nil)
  }

  @Test func verifiesOnlyWhatTheLoginEnvironmentWouldStart() throws {
    let bins = Bins()
    let executable = try bins.server(in: "a")
    _ = try bins.server(in: "b")
    let started = [
      "PATH": "\(bins.dir("a")):/usr/bin", "STIM_HOME": "/tmp/home", "ANDROID_HOME": "/sdk", "EDITOR": "vi",
    ]
    func verifies(_ change: [String: String?], override: String? = nil) -> Bool {
      var login = started
      for (name, value) in change { login[name] = value }
      return ProvisionalServerStart.verifies(executable: executable, started: started, login: login, override: override)
    }

    #expect(verifies([:]))
    #expect(verifies(["EDITOR": "nano", "SHLVL": "2", "STIM_RUN_ID": "run-2"]))
    #expect(!verifies(["STIM_HOME": "/tmp/profile-home"]))
    #expect(!verifies(["STIM_HOME": nil]))
    #expect(!verifies(["ANDROID_HOME": "/other-sdk"]))
    #expect(!verifies(["JAVA_HOME": "/jdk"]))
    #expect(!verifies(["STIM_KEYSTORE_PASSWORD": "hunter2"]))
    #expect(!verifies(["PATH": "\(bins.dir("b")):\(bins.dir("a")):/usr/bin"]))
    #expect(!verifies([:], override: "\(bins.dir("b"))/stim-server"))
  }
}
