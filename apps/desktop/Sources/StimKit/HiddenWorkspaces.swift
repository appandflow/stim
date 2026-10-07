import Foundation

extension Workspace {
  public var worktreeActionKey: String { "worktree:\(worktree?.path ?? path)" }
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

  public func reconciled(
    environments: [Workspace], unprovisioned: [UnprovisionedWorktree]?, archived: [ArchivedWorkspace]?,
    isBusy: (String) -> Bool
  ) -> HiddenWorkspaces {
    let pages = WorktreePage.groups(environments: environments)
    var kept = self
    for path in paths {
      if let page = pages.first(where: { $0.id == path }) {
        if page.apps.contains(where: \.isActive) || isBusy(page.actionKey) || page.apps.contains(where: { isBusy($0.path) }) {
          kept.paths.remove(path)
        }
      } else if let env = environments.first(where: { $0.path == path }) {
        if env.isActive || isBusy(env.path) { kept.paths.remove(path) }
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
