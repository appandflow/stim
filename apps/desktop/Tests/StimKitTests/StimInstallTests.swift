import Foundation
import Testing

@testable import StimKit

@Suite struct StimInstallTests {
  private func machine(_ code: String? = "stim-build", state: String = "approved") throws -> BuildMachineStatus {
    let problems =
      code.map { #","offloadable":false,"problems":[{"code":"\#($0)","reason":"Stim build a there, b here"}]"# } ?? ""
    return try JSONDecoder().decode(
      BuildMachineStatus.self, from: Data(#"{"machine":"mini","state":"\#(state)"\#(problems)}"#.utf8))
  }

  private func remote(
    version: String = "1.25.0", service: String? = "dev.stim.server", acceptsClientBuilds: Bool = false
  ) throws -> MachineUpdateStatus {
    let label = service.map { "\"\($0)\"" } ?? "null"
    return try JSONDecoder().decode(
      MachineUpdateStatus.self,
      from: Data(
        #"""
        {"remote":{"server":{"version":"\#(version)","stimBuild":"a"},"service":\#(label),
          "acceptsClientBuilds":\#(acceptsClientBuilds),"running":null,"last":null},"unreachable":null,"upload":null}
        """#.utf8))
  }

  private let release = LocalStim(version: "1.25.0", isRelease: true)

  @Test func neverOffersAnOlderBuildToARemoteMacOnANewerRelease() throws {
    let older = LocalStim(version: "1.24.0", isRelease: true)
    let result = stimInstall(for: try machine(), remote: try remote(version: "1.25.0", acceptsClientBuilds: true), local: older)
    #expect(
      result
        == .blocked(
          StimInstallBlock(
            reason: "mini runs Stim 1.25.0, newer than this Mac (1.24.0). Update Stim Desktop to match.",
            action: .checkForUpdates)))
    #expect(result?.block?.remoteIsNewer == true)
    #expect(stimInstall(for: try machine(), remote: try remote(version: "1.9.0"), local: older) == .install)
  }

  @Test func installsOnlyWhenTheRemoteIsOlderOrSameAndWouldAcceptIt() throws {
    #expect(stimInstall(for: try machine(), remote: try remote(version: "1.24.0"), local: release) == .install)
    #expect(stimInstall(for: try machine(), remote: try remote(version: "1.25.0"), local: release) == .install)
    let candidate = LocalStim(version: "1.25.0-rc.1", isRelease: true)
    let result = stimInstall(for: try machine(), remote: try remote(version: "1.25.0"), local: candidate)
    #expect(result?.block?.remoteIsNewer == true)
  }

  @Test func blocksABuildFromACheckoutOnARemoteMacThatTakesOnlyReleases() throws {
    let checkout = LocalStim(version: "1.25.0", isRelease: false)
    let command = "stim settings set server.acceptClientBuilds true"
    let refused = stimInstall(for: try machine(), remote: try remote(version: "1.24.0"), local: checkout)
    #expect(refused?.block?.action == .runOnRemote(command))
    #expect(
      stimInstall(for: try machine(), remote: try remote(version: "1.24.0", acceptsClientBuilds: true), local: checkout)
        == .install)
  }

  @Test func blocksARemoteMacWhoseStimServerCannotUpdateItself() throws {
    let result = stimInstall(for: try machine(), remote: try remote(version: "1.24.0", service: nil), local: release)
    #expect(result?.block?.reason.contains("cannot update itself") == true)
    #expect(result?.block?.action == nil)
  }

  @Test func blocksARemoteMacThatCannotBeReadAndCarriesTheCommandItsRefusalNames() throws {
    let refusal =
      "stim-server on mini cannot be updated from here yet. Update it once there with `stim-server service update`."
    let missing = try JSONDecoder().decode(
      MachineUpdateStatus.self, from: Data(#"{"remote":null,"unreachable":"\#(refusal)","upload":null}"#.utf8))
    #expect(
      stimInstall(for: try machine(), remote: missing, local: release)
        == .blocked(StimInstallBlock(reason: refusal, action: .runOnRemote("stim-server service update"))))
    let silent = try JSONDecoder().decode(
      MachineUpdateStatus.self, from: Data(#"{"remote":null,"unreachable":null,"upload":null}"#.utf8))
    #expect(stimInstall(for: try machine(), remote: silent, local: release)?.block?.reason == "mini did not answer.")
  }

  @Test func waitsForTheReadsInsteadOfOfferingAnInstallBlind() throws {
    #expect(stimInstall(for: try machine(), remote: nil, local: release)?.block != nil)
    #expect(stimInstall(for: try machine(), remote: try remote(version: "1.24.0"), local: nil)?.block != nil)
  }

  @Test func offersNothingUnlessAnApprovedMachineReportsAStimBuildProblem() throws {
    let ready = try remote(version: "1.24.0")
    #expect(stimInstall(for: try machine(state: "pending"), remote: ready, local: release) == nil)
    #expect(stimInstall(for: try machine(state: "unreachable"), remote: ready, local: release) == nil)
    #expect(stimInstall(for: try machine("xcode"), remote: ready, local: release) == nil)
    #expect(stimInstall(for: try machine(nil), remote: ready, local: release) == nil)
  }

  @Test func readsTheCommandInAMessageOnlyWhenItIsAStimCommand() {
    #expect(
      commandToRun(in: "To downgrade it, run `stim-server service update --release 1.24.0` on the machine it runs on.")
        == "stim-server service update --release 1.24.0")
    #expect(commandToRun(in: "Could not write `/tmp/x`: ENOSPC") == nil)
    #expect(commandToRun(in: "No backticks at all.") == nil)
  }

  @Test func tellsAnInstalledReleaseFromACheckoutThroughSymlinks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("stim-install-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let installed = root.appendingPathComponent("lib/node_modules/@stim-cli/server/dist")
    let checkout = root.appendingPathComponent("checkout/packages/server/dist")
    for directory in [installed, checkout] {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: directory.appendingPathComponent("stim-server.mjs").path, contents: Data())
    }
    let bin = root.appendingPathComponent("bin")
    try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(
      at: bin.appendingPathComponent("stim-server"), withDestinationURL: installed.appendingPathComponent("stim-server.mjs"))
    #expect(LocalStim.isInstalledPackage(bin.appendingPathComponent("stim-server").path))
    #expect(!LocalStim.isInstalledPackage(checkout.appendingPathComponent("stim-server.mjs").path))
  }
}
