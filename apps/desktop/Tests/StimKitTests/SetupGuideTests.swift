import Foundation
import Testing

@testable import StimKit

private let stim = CLICompatibility.compatible(SemanticVersion("1.12.0")!)

private func node(_ output: String?) -> CLICompatibility {
  CLICompatibility.check(
    executable: output == nil ? nil : "/opt/homebrew/bin/node", versionOutput: output, minimum: SetupChecks.nodeMinimum)
}

@Test func cliStepWaitsOnNodeOnlyWhenStimIsMissing() {
  #expect(SetupChecks(stim: .missing, node: node("v22.12.0\n")).state(of: .cli) == .pending)
  #expect(SetupChecks(stim: .missing, node: node("v22.11.0\n")).state(of: .cli) == .blocked)
  #expect(SetupChecks(stim: .missing, node: node(nil)).state(of: .cli) == .blocked)
  #expect(SetupChecks(stim: .outdated(found: "1.10.0"), node: node("v24.1.0\n")).state(of: .cli) == .pending)
  #expect(SetupChecks(stim: .missing).state(of: .cli) == .checking)
  #expect(SetupChecks(stim: stim, node: node(nil)).state(of: .cli) == .done)
}

@Test func deniedNotificationsNeedSystemSettingsAndABundlelessBuildSkipsThem() {
  #expect(SetupChecks(notifications: .notDetermined).state(of: .notifications) == .pending)
  #expect(SetupChecks(notifications: .denied).state(of: .notifications) == .blocked)
  #expect(SetupChecks(notifications: .allowed).state(of: .notifications) == .done)
  #expect(SetupChecks(notifications: .unavailable).state(of: .notifications) == .notApplicable)
  #expect(SetupChecks().state(of: .notifications) == .checking)
}

@Test func opensOnTheSummaryWhenEverythingIsAlreadySetUp() {
  let ready = SetupChecks(
    stim: stim, node: node("v22.22.2\n"), skillPath: "/Users/me/.agents/skills/stim/SKILL.md", skillChecked: true,
    notifications: .unavailable)
  #expect(ready.isComplete)
  #expect(ready.startStep(resuming: nil) == .done)
  #expect(ready.startStep(resuming: .skill) == .skill)

  var denied = ready
  denied.notifications = .denied
  #expect(!denied.isComplete)

  var noSkill = ready
  noSkill.skillPath = nil
  #expect(!noSkill.isComplete)
  #expect(noSkill.startStep(resuming: nil) == .welcome)

  var unchecked = ready
  unchecked.skillChecked = false
  unchecked.skillPath = nil
  #expect(unchecked.state(of: .skill) == .checking)
  #expect(!unchecked.isComplete)
}

@Test func findsTheSkillWhereverTheSkillsCLIPutIt() {
  let home = "/Users/me"
  #expect(
    SetupChecks.installedSkill(home: home) { $0 == "/Users/me/.claude/skills/stim/SKILL.md" }
      == "/Users/me/.claude/skills/stim/SKILL.md")
  #expect(
    SetupChecks.installedSkill(home: home) { $0.hasSuffix("/stim/SKILL.md") }
      == "/Users/me/.agents/skills/stim/SKILL.md")
  #expect(SetupChecks.installedSkill(home: home) { $0.contains("other-skill") } == nil)
}

@Test func readsXcodeAndJavaVersions() {
  #expect(MachineCheck.xcode("Xcode 26.0\nBuild version 17A324\n") == "Xcode 26.0")
  #expect(
    MachineCheck.xcode(
      "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance\n"
    ) == nil)
  #expect(
    MachineCheck.java(
      "openjdk version \"17.0.12\" 2024-07-16\nOpenJDK Runtime Environment Zulu17.52+17-CA (build 17.0.12+7-LTS)\n")
      == "17.0.12")
  #expect(MachineCheck.java("The operation couldn't be completed. Unable to locate a Java Runtime.\n") == nil)
}

@Test func findsTheAndroidSDKInStimsOrder() {
  let exists: (String) -> Bool = { ["/sdk/home", "/sdk/root", "/Users/me/Library/Android/sdk"].contains($0) }
  #expect(
    MachineCheck.androidSDK(
      environment: ["ANDROID_HOME": "/sdk/home", "ANDROID_SDK_ROOT": "/sdk/root"], home: "/Users/me",
      exists: exists) == "/sdk/home")
  #expect(
    MachineCheck.androidSDK(environment: ["ANDROID_SDK_ROOT": "/sdk/root"], home: "/Users/me", exists: exists)
      == "/sdk/root")
  #expect(MachineCheck.androidSDK(environment: [:], home: "/Users/me", exists: exists) == "/Users/me/Library/Android/sdk")
  #expect(MachineCheck.androidSDK(environment: ["ANDROID_HOME": "/gone"], home: "/Users/me", exists: exists) == nil)
}

@Test func guideOpensUntilClosedAndReopensOnTheStepARestartSaved() throws {
  let suite = "SetupGuideTests-\(UUID().uuidString)"
  let defaults = try #require(UserDefaults(suiteName: suite))
  defer { defaults.removePersistentDomain(forName: suite) }
  let progress = SetupGuideProgress(defaults)

  #expect(progress.opensAtLaunch)
  progress.saveForRestart(at: .check)
  #expect(progress.resumeStep == .check)
  progress.resumed()
  #expect(progress.resumeStep == nil)
  #expect(progress.opensAtLaunch)

  progress.finish()
  #expect(!progress.opensAtLaunch)

  progress.saveForRestart(at: .cli)
  #expect(progress.opensAtLaunch)
  #expect(progress.resumeStep == .cli)
  progress.finish()
  #expect(progress.resumeStep == nil)
  #expect(!progress.opensAtLaunch)
}
