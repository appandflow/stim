import Foundation

public struct WizardSample: Sendable {
  public let onboarding: URL
  public var folder: URL { onboarding.appendingPathComponent("sample-sdk57", isDirectory: true) }
  public var marker: URL { folder.appendingPathComponent(".stim-sample-ready") }
  public init(applicationSupport: URL) {
    onboarding = applicationSupport.appendingPathComponent("Stim Desktop/Onboarding", isDirectory: true)
  }
  public static var desktop: Self {
    Self(applicationSupport: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])
  }
  public func permitsRemoval(_ candidate: URL) -> Bool {
    let root = onboarding.standardizedFileURL.resolvingSymlinksInPath()
    let target = candidate.standardizedFileURL.resolvingSymlinksInPath()
    return candidate.standardizedFileURL == folder.standardizedFileURL && target.deletingLastPathComponent() == root
      && target.lastPathComponent == "sample-sdk57"
  }
  public var prepareCommands: [StimCommand] {
    [
      StimCommand(
        [
          "--yes", "create-expo-app@5.0.0", "sample", "--template", "expo-template-blank@57.0.29", "--no-install",
          "--no-agents-md", "--yes",
        ], cwd: onboarding.path, program: "npx")
    ]
      + [
        StimCommand(["install"], cwd: folder.path, program: "npm"),
        StimCommand(["init"], cwd: folder.path, program: "git"),
        StimCommand(["add", "-A"], cwd: folder.path, program: "git"),
        StimCommand(
          ["-c", "user.name=Stim", "-c", "user.email=stim@localhost", "-c", "commit.gpgsign=false", "commit", "-m", "sample"],
          cwd: folder.path, program: "git"),
      ]
  }
}
