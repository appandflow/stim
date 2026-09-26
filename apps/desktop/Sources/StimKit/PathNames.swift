import Foundation

/// Display names for a workspace, the same as the phone app's.
///
/// The title is the worktree's branch, else the worktree's folder, else the project for a main checkout.
/// `stim status` reports worktree facts only for linked worktrees, so a main checkout is named after its
/// project, and after its own folder until the project is known. `inCheckout` is where the workspace sits
/// inside its checkout, such as `apps/mobile`, or nil at the checkout root.
public struct PathNames: Hashable, Sendable {
  public var title: String
  public var inCheckout: String?

  public init(path: String, branch: String? = nil, worktree: String? = nil, project: Project? = nil) {
    let checkout = worktree ?? markedCheckout(path)
    title = branch ?? checkout.map(lastComponent) ?? project?.name ?? lastComponent(path)
    inCheckout = pathInCheckout(path, worktree: worktree ?? project?.root)
  }
}

private func lastComponent(_ path: String) -> String {
  path.split(separator: "/").last.map(String.init) ?? path
}

/// The `.worktrees/<name>` or `.claude/worktrees/<name>` folder holding `path`.
private func markedCheckout(_ path: String) -> String? {
  let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  var i = parts.count - 2
  while i > 0 {
    if parts[i] == ".worktrees" || (parts[i] == "worktrees" && parts[i - 1] == ".claude") {
      return parts[...(i + 1)].joined(separator: "/")
    }
    i -= 1
  }
  return nil
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
  guard let base = markedCheckout(path) ?? worktree, path.hasPrefix(base + "/") else { return nil }
  return String(path.dropFirst(base.count + 1))
}
