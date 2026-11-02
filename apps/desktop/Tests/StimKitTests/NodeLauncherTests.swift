import Foundation
import Testing

@testable import StimKit

private struct VersionManagerFixture {
  let root: String
  let home: String
  let project: String
  let script: String
  let environment: [String: String]

  init() throws {
    root = (NSTemporaryDirectory() as NSString).appendingPathComponent("node-launcher-\(UUID().uuidString)")
    home = root + "/home"
    project = root + "/project"
    script = root + "/prefix/lib/node_modules/stim/dist/cli.mjs"
    environment = ["PATH": "\(root)/shims:/usr/bin:/bin", "HOME": home]
    let fm = FileManager.default
    for directory in [home, project, root + "/shims", root + "/prefix/bin", (script as NSString).deletingLastPathComponent] {
      try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
    }
    try "18\n".write(toFile: project + "/.nvmrc", atomically: true, encoding: .utf8)
    try write(
      root + "/shims/node", "if [ -f .nvmrc ]; then exec \"\(root)/v18/node\" \"$@\"; fi\nexec \"\(root)/v22/node\" \"$@\"")
    try installNode("18.20.0")
    try installNode("22.12.0")
    try "#!/usr/bin/env node\n".write(toFile: script, atomically: true, encoding: .utf8)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script)
    try fm.createSymbolicLink(atPath: root + "/prefix/bin/stim", withDestinationPath: "../lib/node_modules/stim/dist/cli.mjs")
  }

  func installNode(_ version: String) throws {
    let major = version.split(separator: ".")[0]
    try FileManager.default.createDirectory(atPath: "\(root)/v\(major)", withIntermediateDirectories: true)
    try write(
      "\(root)/v\(major)/node",
      "if [ \"$1\" = -p ]; then echo \"$0\"; echo \(version); exit 0; fi\necho \"node \(version) $*\"")
  }

  func write(_ path: String, _ body: String) throws {
    try "#!/bin/sh\n\(body)\n".write(toFile: path, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
  }

  var realScript: String { (script as NSString).resolvingSymlinksInPath }
}

@Suite struct NodeLauncherTests {
  private func run(_ launcher: NodeLauncher, in fixture: VersionManagerFixture) async throws -> Data {
    let command = try launcher.command(["--version"])
    return try await ProcessRequest(
      command.program, command.arguments, cwd: fixture.project, environment: fixture.environment
    ).run().stdout
  }

  @Test func runsStimOnTheHomeDirectorysNodeWhereAProjectPinsAnOlderOne() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    let stim = fixture.root + "/prefix/bin/stim"

    let pinned = try await ProcessRequest(
      stim, ["--version"], cwd: fixture.project, environment: fixture.environment
    ).run().stdout
    #expect(String(decoding: pinned, as: UTF8.self).hasPrefix("node 18.20.0 "))

    let cli = try #require(await NodeLauncher.resolve(executable: stim, name: "stim", environment: fixture.environment))
    let output = try await run(cli, in: fixture)
    #expect(String(decoding: output, as: UTF8.self) == "node 22.12.0 \(fixture.realScript) --version\n")
  }

  @Test func aVersionManagerShimRunsTheScriptOfTheGlobalInstall() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    try fixture.write(fixture.root + "/shims/stim", "exec asdf exec stim \"$@\"")
    let layout = PackageManagerLayout(npmPrefix: fixture.root + "/prefix", installed: [.npm])

    let launcher = await NodeLauncher.resolve(
      executable: fixture.root + "/shims/stim", name: "stim", environment: fixture.environment
    ) { layout }

    #expect(launcher?.script == fixture.realScript)
    #expect(launcher?.runtime == NodeRuntime(path: fixture.root + "/v22/node", version: "22.12.0"))
  }

  @Test func aWrapperScriptRunsAsItIsEvenWithAGlobalInstall() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    try FileManager.default.createDirectory(atPath: fixture.root + "/wrappers", withIntermediateDirectories: true)
    try fixture.write(fixture.root + "/wrappers/stim", "export STIM_HOME=/tmp/elsewhere\nexec stim \"$@\"")
    let layout = PackageManagerLayout(npmPrefix: fixture.root + "/prefix", installed: [.npm])

    let launcher = await NodeLauncher.resolve(
      executable: fixture.root + "/wrappers/stim", name: "stim", environment: fixture.environment
    ) { layout }

    #expect(launcher == nil)
  }

  @Test func runsTheScriptAnUpdateMovedTheExecutableTo() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    let fm = FileManager.default
    let link = fixture.root + "/prefix/bin/stim"
    let launcher = try #require(
      await NodeLauncher.resolve(
        executable: link, name: "stim", environment: fixture.environment
      ) { PackageManagerLayout() })
    let updated = fixture.root + "/store/stim@2/dist/cli.mjs"
    try fm.createDirectory(atPath: (updated as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try "#!/usr/bin/env node\n".write(toFile: updated, atomically: true, encoding: .utf8)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: updated)
    try fm.removeItem(atPath: fixture.script)
    try fm.removeItem(atPath: link)
    try fm.createSymbolicLink(atPath: link, withDestinationPath: updated)

    #expect(try launcher.command(["--version"]).arguments == [(updated as NSString).resolvingSymlinksInPath, "--version"])
  }

  @Test func findsTheNodeAgainOnceItsBinaryIsGone() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    let launcher = try #require(
      await NodeLauncher.resolve(executable: fixture.script, name: "stim", environment: fixture.environment) {
        PackageManagerLayout()
      })
    try FileManager.default.removeItem(atPath: fixture.root + "/v22/node")
    try fixture.installNode("22.22.0")
    try FileManager.default.moveItem(atPath: fixture.root + "/v22", toPath: fixture.root + "/v22-new")
    try fixture.write(fixture.root + "/shims/node", "exec \"\(fixture.root)/v22-new/node\" \"$@\"")

    #expect(try launcher.command(["--version"]).program == fixture.root + "/v22-new/node")
  }

  @Test func refusesAHomeNodeOlderThanStimSupportsNamingItsPath() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    try fixture.installNode("20.11.0")
    try fixture.write(fixture.root + "/shims/node", "exec \"\(fixture.root)/v20/node\" \"$@\"")
    let cli = try #require(
      await NodeLauncher.resolve(
        executable: fixture.root + "/prefix/bin/stim", name: "stim", environment: fixture.environment,
        layout: { PackageManagerLayout() }))

    await #expect(throws: NodeLauncher.Unsupported(runtime: NodeRuntime(path: fixture.root + "/v20/node", version: "20.11.0"))) {
      try await run(cli, in: fixture)
    }
  }

  @Test func refusesFailedRedetectionInsteadOfRunningTheProjectsNode() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    let cli = try #require(
      await NodeLauncher.resolve(executable: fixture.root + "/prefix/bin/stim", name: "stim", environment: fixture.environment))
    try FileManager.default.removeItem(atPath: fixture.root + "/v22/node")

    await #expect(throws: NodeLauncher.Unavailable.self) {
      try await run(cli, in: fixture)
    }
  }

  @Test func recoversTheSameLauncherAfterTheInitialNodeProbeFails() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    try FileManager.default.removeItem(atPath: fixture.root + "/v22/node")
    let launcher = try #require(
      await NodeLauncher.resolve(
        executable: fixture.root + "/prefix/bin/stim", name: "stim", environment: fixture.environment,
        reprobeInterval: 0))
    #expect(throws: NodeLauncher.Unavailable.self) { try launcher.command(["--version"]) }

    try fixture.installNode("22.12.0")
    let command = try launcher.command(["--version"])
    let result = try await ProcessRequest(
      command.program, command.arguments, cwd: fixture.project, environment: fixture.environment
    ).run()
    #expect(result.stdoutText == "node 22.12.0 \(fixture.realScript) --version\n")
  }

  @Test func refusesAKnownShimWhoseGlobalInstallCannotResolve() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    let shim = fixture.root + "/shims/stim"
    try fixture.write(shim, "exec node \"\(fixture.script)\" \"$@\"")
    let cli = try #require(
      await NodeLauncher.resolve(
        executable: shim, name: "stim", environment: fixture.environment, layout: { PackageManagerLayout() }))

    await #expect(throws: NodeLauncher.ScriptUnavailable.self) {
      try await run(cli, in: fixture)
    }

    let restored = try #require(
      await NodeLauncher.resolve(
        executable: shim, name: "stim", environment: fixture.environment,
        layout: { PackageManagerLayout(npmPrefix: fixture.root + "/prefix", installed: [.npm]) }))
    #expect(cli.source == shim)
    #expect(restored.source != cli.source)
    let output = try await run(restored, in: fixture)
    #expect(String(decoding: output, as: UTF8.self) == "node 22.12.0 \(fixture.realScript) --version\n")

    try FileManager.default.removeItem(atPath: fixture.script)
    await #expect(throws: NodeLauncher.ScriptUnavailable.self) {
      try await run(restored, in: fixture)
    }
  }

  @Test func runsOnTheNewDefaultOnceTheRefusedNodeIsReplaced() async throws {
    let fixture = try VersionManagerFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.root) }
    try fixture.installNode("20.11.0")
    try fixture.write(fixture.root + "/shims/node", "exec \"\(fixture.root)/v20/node\" \"$@\"")
    let launcher = try #require(
      await NodeLauncher.resolve(
        executable: fixture.script, name: "stim", environment: fixture.environment,
        layout: { PackageManagerLayout() }, reprobeInterval: 0))
    #expect(throws: NodeLauncher.Unsupported.self) { try launcher.command(["--version"]) }

    try fixture.write(fixture.root + "/shims/node", "exec \"\(fixture.root)/v22/node\" \"$@\"")

    #expect(try launcher.command(["--version"]).program == fixture.root + "/v22/node")
  }
}
