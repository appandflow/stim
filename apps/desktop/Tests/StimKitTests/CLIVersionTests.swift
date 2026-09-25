import Foundation
import Testing

@testable import StimKit

private let minimum = SemanticVersion("1.11.0")!

@Test func readsVersionOutput() {
  #expect(SemanticVersion("1.11.0\n")?.description == "1.11.0")
  #expect(SemanticVersion("stim v1.12.3+abc")?.description == "1.12.3")
  #expect(SemanticVersion("1.12.0-rc.1")?.prerelease == ["rc", "1"])
  #expect(SemanticVersion("1.11") == nil)
  #expect(SemanticVersion("") == nil)
}

@Test func ordersVersionsBySemverPrecedence() {
  let ordered = ["1.9.9", "1.10.0", "1.11.0-alpha", "1.11.0-alpha.1", "1.11.0-beta", "1.11.0-rc.2", "1.11.0-rc.10", "1.11.0", "2.0.0"]
    .map { SemanticVersion($0)! }
  #expect(ordered == ordered.sorted())
  #expect(zip(ordered, ordered.dropFirst()).allSatisfy { $0 < $1 })
}

@Test func checksInstalledCLI() {
  #expect(CLICompatibility.check(executable: nil, versionOutput: nil, minimum: minimum) == .missing)
  #expect(
    CLICompatibility.check(executable: "/bin/stim", versionOutput: "1.10.2\n", minimum: minimum)
      == .outdated(found: "1.10.2"))
  #expect(
    CLICompatibility.check(executable: "/bin/stim", versionOutput: "1.11.0\n", minimum: minimum)
      == .compatible(SemanticVersion("1.11.0")!))
  #expect(
    CLICompatibility.check(executable: "/bin/stim", versionOutput: nil, minimum: minimum) == .outdated(found: nil))
  #expect(
    CLICompatibility.check(executable: "/bin/stim", versionOutput: "error: unknown option\n", minimum: minimum)
      == .outdated(found: "error: unknown option"))
}

@Test func prereleaseOfTheMinimumIsOutdatedAndOfALaterVersionIsCompatible() {
  #expect(
    CLICompatibility.check(executable: "/bin/stim", versionOutput: "1.11.0-rc.1", minimum: minimum)
      == .outdated(found: "1.11.0-rc.1"))
  #expect(
    CLICompatibility.check(executable: "/bin/stim", versionOutput: "1.12.0-rc.1", minimum: minimum).isCompatible)
}

@Test func offersOnlyTheViewerSettingsTheCLIListsAndDoesNotAlreadySetToStimDesktop() throws {
  func entries(_ ios: String, _ android: String) throws -> [SettingEntry] {
    try JSONDecoder().decode(
      [SettingEntry].self,
      from: Data(
        #"[{"key":"iosSimulatorApp","value":"\#(ios)","layers":{}},{"key":"androidEmulatorApp","value":"\#(android)","layers":{}}]"#
          .utf8))
  }
  #expect(DesktopViewerSettings.unset(in: try entries("xcode", "emulator")) == ["iosSimulatorApp", "androidEmulatorApp"])
  #expect(DesktopViewerSettings.unset(in: try entries("stim-desktop", "emulator")) == ["androidEmulatorApp"])
  #expect(DesktopViewerSettings.unset(in: try entries("stim-desktop", "stim-desktop")).isEmpty)
  #expect(DesktopViewerSettings.unset(in: Array(try entries("xcode", "emulator").prefix(1))) == ["iosSimulatorApp"])
  #expect(DesktopViewerSettings.unset(in: []).isEmpty)
}
