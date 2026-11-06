import Foundation
import Testing

@testable import StimKit

@Suite struct StimHomeTests {
  @Test func sharedSocketMetadataRejectsForeignOwnersOpenPermissionsAndLinks() {
    let uid = getuid()
    let other: uid_t = uid == 0 ? 1 : 0
    var directory = stat()
    directory.st_mode = S_IFDIR | 0o700
    directory.st_uid = uid
    var socket = stat()
    socket.st_mode = S_IFSOCK | 0o600
    socket.st_uid = uid
    #expect(StimHome.isPrivateLocalSocket(directory: directory, socket: socket))
    let invalid: [(mode_t, uid_t, mode_t, uid_t)] = [
      (S_IFDIR | 0o700, other, S_IFSOCK | 0o600, uid),
      (S_IFDIR | 0o700, uid, S_IFSOCK | 0o600, other),
      (S_IFDIR | 0o777, uid, S_IFSOCK | 0o600, uid),
      (S_IFDIR | 0o700, uid, S_IFSOCK | 0o666, uid),
      (S_IFLNK | 0o700, uid, S_IFSOCK | 0o600, uid),
      (S_IFDIR | 0o700, uid, S_IFLNK | 0o600, uid),
    ]
    for (directoryMode, directoryUID, socketMode, socketUID) in invalid {
      directory.st_mode = directoryMode
      directory.st_uid = directoryUID
      socket.st_mode = socketMode
      socket.st_uid = socketUID
      #expect(!StimHome.isPrivateLocalSocket(directory: directory, socket: socket))
    }
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

  @Test func canonicalHomesMatchThroughSymlinks() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("home-\(UUID().uuidString)").path
    defer { try? FileManager.default.removeItem(atPath: home) }
    try FileManager.default.createDirectory(atPath: "\(home)/state", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(home)/.stim", withDestinationPath: "\(home)/state")
    #expect(StimHome.isDefault("\(home)/state", home: home))
    #expect(!StimHome.isDefault("\(home)/state/child", home: home))
  }
}
