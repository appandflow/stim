import Foundation
import Testing

@testable import StimKit

private let layout = PackageManagerLayout(
  npmPrefix: "/Users/me/.nvm/versions/node/v22.22.2",
  pnpmRoot: "/Users/me/Library/pnpm/global/v11",
  pnpmBin: "/Users/me/Library/pnpm/bin",
  bunBin: "/Users/me/.bun/bin",
  installed: [.npm, .pnpm, .bun])

@Suite struct PackageManagerOwnerTests {
  @Test func npmOwnsAStimUnderItsGlobalNodeModules() {
    #expect(
      layout.owner(ofTarget: "/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/stim/dist/cli.mjs") == .npm)
  }

  @Test func pnpmOwnsAStimUnderItsGlobalRootOnBothLayouts() {
    #expect(
      layout.owner(ofTarget: "/Users/me/Library/pnpm/global/v11/4a82/node_modules/stim/dist/cli.mjs") == .pnpm)
    var old = layout
    old.pnpmRoot = "/Users/me/Library/pnpm/global/5/node_modules"
    #expect(
      old.owner(ofTarget: "/Users/me/Library/pnpm/global/5/node_modules/.pnpm/stim@1.14.0/node_modules/stim/dist/cli.mjs")
        == .pnpm)
  }

  @Test func bunOwnsAStimUnderItsInstallDirectory() {
    #expect(layout.owner(ofTarget: "/Users/me/.bun/install/global/node_modules/stim/dist/cli.mjs") == .bun)
  }

  @Test func aLinkedCheckoutOrProjectLocalStimHasNoOwner() {
    #expect(layout.owner(ofTarget: "/Users/me/Developer/stim/packages/stim-cli/dist/cli.mjs") == nil)
    #expect(layout.owner(ofTarget: "/Users/me/app/node_modules/stim/dist/cli.mjs") == nil)
  }

  @Test func aSiblingPackageOrDirectoryWithTheSamePrefixIsNotOwned() {
    #expect(layout.owner(ofTarget: "/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/stim-other/cli.mjs") == nil)
    #expect(layout.owner(ofTarget: "/Users/me/Library/pnpm/global/v110/x/node_modules/stim/cli.mjs") == nil)
  }

  @Test func aManagerThatCouldNotBeQueriedOwnsNothing() {
    #expect(PackageManagerLayout().owner(ofTarget: "/Users/me/.bun/install/global/node_modules/stim/dist/cli.mjs") == nil)
  }
}

@Suite struct PackageManagerTargetTests {
  @Test func aPnpmShimNamesItsTarget() {
    let shim = """
      #!/bin/sh
      exec node "$basedir/../global/v11/4a82/node_modules/stim/dist/cli.mjs" "$@"
      # cmd-shim-target=/Users/me/Library/pnpm/global/v11/4a82/node_modules/stim/dist/cli.mjs
      """
    #expect(
      PackageManagerLayout.target(ofExecutable: "/Users/me/Library/pnpm/bin/stim", contents: shim)
        == "/Users/me/Library/pnpm/global/v11/4a82/node_modules/stim/dist/cli.mjs")
  }

  @Test func aScriptWithoutAShimMarkerIsItsOwnTarget() {
    #expect(
      PackageManagerLayout.target(ofExecutable: "/Users/me/bin/stim", contents: "#!/usr/bin/env node\n")
        == "/Users/me/bin/stim")
  }

  @Test func resolvesSymbolicLinksOnDisk() throws {
    let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("pm-\(UUID().uuidString)")
    let fm = FileManager.default
    try fm.createDirectory(atPath: root + "/prefix/lib/node_modules/stim/dist", withIntermediateDirectories: true)
    try fm.createDirectory(atPath: root + "/prefix/bin", withIntermediateDirectories: true)
    try fm.createDirectory(atPath: root + "/checkout/dist", withIntermediateDirectories: true)
    try fm.createDirectory(atPath: root + "/local", withIntermediateDirectories: true)
    defer { try? fm.removeItem(atPath: root) }
    let real = root + "/prefix/lib/node_modules/stim/dist/cli.mjs"
    try "#!/usr/bin/env node\n".write(toFile: real, atomically: true, encoding: .utf8)
    try "#!/usr/bin/env node\n".write(toFile: root + "/checkout/dist/cli.mjs", atomically: true, encoding: .utf8)
    try fm.createSymbolicLink(atPath: root + "/prefix/bin/stim", withDestinationPath: "../lib/node_modules/stim/dist/cli.mjs")
    try fm.createSymbolicLink(atPath: root + "/local/stim", withDestinationPath: root + "/checkout/dist/cli.mjs")
    let canonical = (root as NSString).resolvingSymlinksInPath
    let probed = PackageManagerLayout(npmPrefix: canonical + "/prefix", installed: [.npm])
    #expect(probed.owner(ofExecutable: root + "/prefix/bin/stim") == .npm)
    #expect(probed.owner(ofExecutable: root + "/local/stim") == nil)
  }
}

@Suite struct PackageManagerInstallTests {
  @Test func eachManagerUsesItsOwnGlobalInstallVerb() {
    #expect(PackageManager.npm.installCommand("stim@latest", cwd: "/h").arguments == ["install", "--global", "stim@latest"])
    #expect(PackageManager.pnpm.installCommand("stim@latest", cwd: "/h").arguments == ["add", "--global", "stim@latest"])
    let bun = PackageManager.bun.installCommand("stim@latest", cwd: "/h")
    #expect(bun.program == "bun")
    #expect(bun.arguments == ["add", "--global", "stim@latest"])
  }

  @Test func freshInstallDefaultsToTheManagerWhoseBinIsOnPath() {
    #expect(layout.defaultInstaller(path: "/usr/bin:/Users/me/Library/pnpm/bin/:/bin") == .pnpm)
    #expect(layout.defaultInstaller(path: "/usr/bin:/Users/me/.bun/bin") == .bun)
    #expect(layout.defaultInstaller(path: "/usr/bin:/bin") == .npm)
    var noPnpm = layout
    noPnpm.installed = [.npm, .bun]
    #expect(noPnpm.defaultInstaller(path: "/Users/me/Library/pnpm/bin") == .npm)
  }
}
