import Foundation

/// Short display names for a workspace path.
///
/// A worktree under `.worktrees/<name>` or `worktrees/<name>` is titled by its
/// worktree name, subtitled by the package directory inside it, or by the
/// repository when the worktree is the package.
public struct PathNames: Hashable, Sendable {
  public var title: String
  public var subtitle: String

  public init(path: String) {
    let parts = path.split(separator: "/").map(String.init)
    for marker in [".worktrees", "worktrees"] {
      if let i = parts.lastIndex(of: marker), i + 1 < parts.count {
        let name = parts[i + 1]
        let last = parts[parts.count - 1]
        title = name
        subtitle = last == name ? (i > 0 ? parts[i - 1] : "") : last
        return
      }
    }
    title = parts.last ?? path
    subtitle = parts.count > 1 ? parts[parts.count - 2] : ""
  }
}

/// `text` with the home directory written as `~` wherever a path starts with it.
public func abbreviatingHome(_ text: String, home: String = NSHomeDirectory()) -> String {
  guard home.count > 1, text.contains(home) else { return text }
  let pattern = "(?<![\\w./-])" + NSRegularExpression.escapedPattern(for: home) + "(?![\\w.-])"
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
  return regex.stringByReplacingMatches(
    in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "~")
}
