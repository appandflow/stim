import Foundation

public struct WizardSample: Sendable {
  public let onboarding: URL
  public var folder: URL { onboarding.appendingPathComponent("sample-sdk58", isDirectory: true) }
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
    return candidate.standardizedFileURL.path == folder.standardizedFileURL.path
      && target.deletingLastPathComponent().path == root.path
      && target.lastPathComponent == "sample-sdk58"
  }
  public var prepareCommands: [StimCommand] {
    [
      StimCommand(
        [
          "--yes", "create-expo-app@5.0.0", "sample", "--template", "expo-template-blank@58.0.15", "--no-install",
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
