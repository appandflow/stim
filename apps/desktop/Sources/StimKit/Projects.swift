import Foundation

/// The repository a workspace belongs to. Every worktree of a repository
/// shares one project, wherever the worktree lives on disk.
public struct Project: Hashable, Identifiable, Sendable {
  public var root: String
  public var name: String { (root as NSString).lastPathComponent }
  public var id: String { root }

  public init(root: String) {
    self.root = root
  }

  /// The project for a `git rev-parse --git-common-dir` result: the checkout
  /// that owns `.git`, or the directory itself for a bare repository.
  public init(gitCommonDir: String) {
    let trimmed = gitCommonDir.hasSuffix("/") ? String(gitCommonDir.dropLast()) : gitCommonDir
    root = trimmed.hasSuffix("/.git") ? String(trimmed.dropLast(5)) : trimmed
  }

  /// The project for a workspace git cannot answer for, such as a path that no
  /// longer exists: the directory above a `.worktrees` folder, else the path.
  public init(fallbackFor path: String) {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    if let i = parts.lastIndex(of: ".worktrees"), i > 0 {
      root = parts[..<i].joined(separator: "/")
    } else {
      root = path
    }
  }

  public static func resolve(workspace path: String) -> Project {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return Project(fallbackFor: path) }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let dir = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    guard process.terminationStatus == 0, dir.hasPrefix("/") else { return Project(fallbackFor: path) }
    return Project(gitCommonDir: (dir as NSString).resolvingSymlinksInPath)
  }
}

/// The branch checked out at `path`, or nil for a detached HEAD or a path git cannot read.
public func currentBranch(at path: String) -> String? {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
  process.arguments = ["-C", path, "branch", "--show-current"]
  let out = Pipe()
  process.standardOutput = out
  process.standardError = FileHandle.nullDevice
  guard (try? process.run()) != nil else { return nil }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  let branch = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  return process.terminationStatus == 0 && !branch.isEmpty ? branch : nil
}
