import Foundation

/// What Restart Tutorial deletes: the tutorial worktrees, then the clone.
public enum TutorialCleanupPlan: Equatable, Sendable {
  case remove(worktrees: [String])
  case refuse(String)
}

/// Removes only a folder that carries the tutorial marker.
public func tutorialCleanupPlan(base: String, hasMarker: Bool, linkedWorktrees: [String]) -> TutorialCleanupPlan {
  hasMarker
    ? .remove(worktrees: linkedWorktrees)
    : .refuse("\(base) is not the tutorial clone (no tutorial marker in app.json), so Restart leaves it alone.")
}

public struct TutorialCleanup: Sendable {
  public struct Failure: LocalizedError {
    public var message: String
    public var errorDescription: String? { message }
  }

  let cli: StimCLI

  public init(cli: StimCLI) { self.cli = cli }

  /// The plan for `base`, or nil when there is no folder there.
  public func plan(base: String) async throws -> TutorialCleanupPlan? {
    guard FileManager.default.fileExists(atPath: base) else { return nil }
    let marker = Self.hasMarker(at: base)
    guard marker else { return tutorialCleanupPlan(base: base, hasMarker: false, linkedWorktrees: []) }
    let list = try await ProcessRequest("/usr/bin/git", ["worktree", "list", "--porcelain"], cwd: base, timeout: 30).run()
    guard list.succeeded else { throw Failure(message: "git worktree list failed in \(base).") }
    let paths = Self.worktreePaths(list.stdoutText)
    guard let first = paths.first,
      URL(fileURLWithPath: first).resolvingSymlinksInPath() == URL(fileURLWithPath: base).resolvingSymlinksInPath()
    else { return .refuse("\(base) is not the root of its own git repository, so Restart leaves it alone.") }
    return tutorialCleanupPlan(base: base, hasMarker: true, linkedWorktrees: Array(paths.dropFirst()))
  }

  public func remove(base: String, worktrees: [String]) async throws {
    for path in worktrees where FileManager.default.fileExists(atPath: path) {
      _ = try await cli.run(["stop"], cwd: path)
      _ = try await cli.run(["worktree", "remove", path], cwd: base)
    }
    _ = try await cli.run(["stop"], cwd: base)
    _ = try await cli.run(["worktree", "remove", base], cwd: base)
    try Self.moveToTrash(base)
  }

  static func worktreePaths(_ porcelain: String) -> [String] {
    porcelain.split(separator: "\n").compactMap { line in
      line.hasPrefix("worktree ") ? String(line.dropFirst("worktree ".count)) : nil
    }
  }

  static func moveToTrash(_ path: String) throws {
    try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil)
  }

  static func hasMarker(at base: String) -> Bool {
    guard let data = FileManager.default.contents(atPath: base + "/app.json"),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let extra = (json["expo"] as? [String: Any])?["extra"] as? [String: Any]
    else { return false }
    return (extra["stimTutorial"] as? Int).map(TutorialSteps.supportedVersions.contains) ?? false
  }
}
