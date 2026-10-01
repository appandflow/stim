import Foundation

/// Turns what needs a person into `attention` notifications, one per item id per episode: an id notifies when it
/// first appears and again only after it has gone and come back.
public enum AttentionNotices {
  public static let keptPrefix = "pr-kept:"

  public struct Result: Sendable {
    /// Ids to pass back as `previous` on the next call.
    public var active: Set<String>
    public var notifications: [OversightNotification]
  }

  /// The notifications for items and kept worktrees not in `previous`. Only items of the `attention` category
  /// count; `stuck`, `looping` and `machine` items notify through their own rules. An id in `previous` that is
  /// absent now stays in `active` while `pending` says its source has not reported yet, such as a doctor run that
  /// has not finished since launch, so it does not notify again when it does. `title` names a workspace and
  /// `machine` titles an item without one.
  public static func update(
    previous: Set<String>, items: [NeedsAttentionItem], kept: [PullRequestCleanup.Flag], machine: String,
    title: (String) -> String, pending: (String) -> Bool = { _ in false }
  ) -> Result {
    var active: Set<String> = []
    var out: [OversightNotification] = []
    func add(_ notification: OversightNotification) {
      active.insert(notification.id)
      if !previous.contains(notification.id) { out.append(notification) }
    }
    for item in items where item.category == .attention {
      add(
        OversightNotification(
          id: item.id, category: .attention, title: item.workspace.map(title) ?? machine, body: item.body, quiet: true,
          thread: nil, target: target(item), remedy: item.remedy))
    }
    for flag in kept {
      let target: OversightTarget =
        flag.pullRequest.url.isEmpty
        ? .workspace(path: flag.path) : .url(path: flag.path, url: flag.pullRequest.url)
      add(
        OversightNotification(
          id: keptPrefix + flag.path, category: .attention, title: title(flag.path), body: flag.text, quiet: true,
          thread: nil, target: target))
    }
    for id in previous where !active.contains(id) && pending(id) { active.insert(id) }
    return Result(active: active, notifications: out)
  }

  private static func target(_ item: NeedsAttentionItem) -> OversightTarget {
    guard let path = item.workspace else { return .machine }
    if item.id.hasPrefix("run-"), let platform = item.id.dropFirst(4).split(separator: ":").first {
      return .build(path: path, platform: String(platform))
    }
    return .workspace(path: path)
  }
}
