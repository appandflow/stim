import Foundation

/// Turns what needs a person into `attention` notifications, one per item id per episode: an id notifies when it
/// first appears and again only after it has gone and come back. A folder that is not a React Native or Expo app
/// raises none.
public enum AttentionNotices {
  public static let keptPrefix = "pr-kept:"

  public struct Result: Sendable {
    /// Ids to pass back as `previous` on the next call.
    public var active: Set<String>
    /// The workspace paths with an item now, whether or not it is new.
    public var paths: Set<String>
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
    var paths: Set<String> = []
    func add(_ notification: OversightNotification) {
      active.insert(notification.id)
      if let path = notification.target.path { paths.insert(path) }
      if !previous.contains(notification.id) { out.append(notification) }
    }
    for item in items where item.category == .attention && !isNotAnApp(item) {
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
    return Result(active: active, paths: paths, notifications: out)
  }

  /// The setup item for a folder that is not a React Native or Expo app: agents run stim in such folders, and
  /// nothing there needs a person.
  static func isNotAnApp(_ item: NeedsAttentionItem) -> Bool {
    item.id.hasPrefix("setup-\(notAnAppFindingCode):")
  }

  private static func target(_ item: NeedsAttentionItem) -> OversightTarget {
    guard let path = item.workspace else { return .machine }
    if item.id.hasPrefix("run-"), let platform = item.id.dropFirst(4).split(separator: ":").first {
      return .build(path: path, platform: String(platform))
    }
    return .workspace(path: path)
  }
}

/// Limits `attention` notifications to one per workspace per run. A workspace's allowance returns when its run
/// ends, because it goes live again, and when it has no item left, so a later item is a new episode.
public struct AttentionRuns: Sendable {
  private var raised: Set<String> = []
  private var live: Set<String> = []

  public init() {}

  /// The notifications to deliver now. `live` holds the paths of the workspaces with a live session and `present` the
  /// paths with an item now. A notification for a workspace already raised is dropped; one with no workspace passes.
  public mutating func admit(
    _ notifications: [OversightNotification], live now: Set<String>, present: Set<String>
  ) -> [OversightNotification] {
    raised.formIntersection(present)
    raised.subtract(now.subtracting(live))
    live = now
    return notifications.filter { notification in
      guard let path = notification.target.path else { return true }
      return raised.insert(path).inserted
    }
  }
}
