import Foundation

extension Workspace {
  public var worktreeActionKey: String { "worktree:\(checkoutPath ?? path)" }
}

public struct HiddenWorkspaces: Codable, Equatable, Sendable {
  public var paths: Set<String> = []
  public var archives: Set<String> = []

  public init(paths: Set<String> = [], archives: Set<String> = []) {
    self.paths = paths
    self.archives = archives
  }

  public var isEmpty: Bool { paths.isEmpty && archives.isEmpty }

  public func contains(_ entry: SidebarEntry) -> Bool {
    switch entry {
    case .workspace(let app): app.hidden == true || paths.contains(app.path)
    case .worktreeGroup(let page): paths.contains(page.id) || page.apps.allSatisfy { contains(.workspace($0)) }
    case .archived(let archive): archives.contains(archive.id)
    case .archivedGroup(let group): group.allSatisfy { archives.contains($0.id) }
    default: paths.contains(entry.path)
    }
  }

  public func setting(path: String, hidden: Bool) -> HiddenWorkspaces {
    var updated = self
    if hidden { updated.paths.insert(path) } else { updated.paths.remove(path) }
    return updated
  }

  public func setting(archives ids: [String], hidden: Bool) -> HiddenWorkspaces {
    var updated = self
    if hidden { updated.archives.formUnion(ids) } else { updated.archives.subtract(ids) }
    return updated
  }

  public static func encode(_ hidden: HiddenWorkspaces) -> String {
    guard !hidden.isEmpty else { return "" }
    let sorted = Stored(paths: hidden.paths.sorted(), archives: hidden.archives.sorted())
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return (try? String(decoding: encoder.encode(sorted), as: UTF8.self)) ?? ""
  }

  public static func decode(_ raw: String) -> HiddenWorkspaces {
    guard let stored = try? JSONDecoder().decode(Stored.self, from: Data(raw.utf8)) else { return HiddenWorkspaces() }
    return HiddenWorkspaces(paths: Set(stored.paths), archives: Set(stored.archives))
  }

  private struct Stored: Codable {
    var paths: [String]
    var archives: [String]
  }

  public func migrations(environments: [Workspace]) -> [(path: String, apps: [Workspace], hidden: Bool)] {
    let pages = WorktreePage.groups(environments: environments)
    return paths.sorted().compactMap { path in
      let apps = pages.first(where: { $0.id == path })?.apps ?? environments.filter { $0.path == path }
      guard !apps.isEmpty, !apps.contains(where: { $0.pathMissing == true }) else { return nil }
      return (path, apps, !apps.contains(where: \.isActive))
    }
  }

  public func reconciled(
    environments: [Workspace], unprovisioned: [UnprovisionedWorktree]?, archived: [ArchivedWorkspace]?,
    isBusy: (String) -> Bool
  ) -> HiddenWorkspaces {
    let pages = WorktreePage.groups(environments: environments)
    var kept = self
    for item in migrations(environments: environments)
    where item.apps.allSatisfy({ ($0.hidden == true) == item.hidden }) {
      kept.paths.remove(item.path)
    }
    for path in paths {
      let apps = pages.first(where: { $0.id == path })?.apps ?? environments.filter { $0.path == path }
      if !apps.isEmpty {
        if apps.count == 1, let app = apps.first, app.pathMissing == true,
          app.isActive || isBusy(app.path) || isBusy(app.worktreeActionKey)
        {
          kept.paths.remove(path)
        }
        continue
      } else if let unprovisioned {
        if unprovisioned.contains(where: { $0.path == path }) {
          if isBusy(path) { kept.paths.remove(path) }
        } else {
          kept.paths.remove(path)
        }
      } else if isBusy(path) {
        kept.paths.remove(path)
      }
    }
    if let archived {
      kept.archives.formIntersection(archived.map(\.id))
    }
    return kept
  }
}
