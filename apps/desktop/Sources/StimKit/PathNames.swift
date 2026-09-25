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

/// Where `path` sits inside its checkout, such as `apps/tlon-mobile`, or nil at the checkout root. The
/// checkout is the `.worktrees/<name>` or `.claude/worktrees/<name>` folder holding the path, else the git
/// worktree `stim status` reports.
public func pathInCheckout(_ path: String, worktree: String?) -> String? {
  let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  var checkout: String?
  var i = parts.count - 2
  while i > 0, checkout == nil {
    if parts[i] == ".worktrees" || (parts[i] == "worktrees" && parts[i - 1] == ".claude") {
      checkout = parts[...(i + 1)].joined(separator: "/")
    }
    i -= 1
  }
  guard let base = checkout ?? worktree, path.hasPrefix(base + "/") else { return nil }
  return String(path.dropFirst(base.count + 1))
}
