import Foundation

public struct WorkspaceFiles: Decodable, Sendable {
  public struct File: Decodable, Identifiable, Sendable {
    public var path: String
    public var staged: Bool
    public var unstaged: Bool
    public var untracked: Bool
    public var status: String
    public var id: String { path }
  }

  public var files: [File]
  public var truncated: Bool
}

public struct WorkspaceDiff: Decodable, Sendable {
  public struct Patch: Decodable, Sendable {
    public enum Section: String, Decodable, Sendable {
      case staged, unstaged, untracked
      public var title: String { self == .untracked ? "New file" : rawValue.capitalized }
    }

    public enum Kind: String, Decodable, Sendable {
      case text, binary, unavailable
      case tooLarge = "too-large"
    }

    public var section: Section
    public var kind: Kind
    public var text: String
  }

  public var path: String
  public var patches: [Patch]
}

public struct WorkspaceDiffRow: Identifiable, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case title, note, plain, added, removed, hunk, context
  }

  public var id: String
  public var kind: Kind
  public var text: String
}

extension WorkspaceDiff {
  /// Flat display rows for every patch section. Row ids are unique across sections. File header lines before the
  /// first hunk and the text of a new file carry no change marker.
  public var rows: [WorkspaceDiffRow] {
    var rows: [WorkspaceDiffRow] = []
    for (section, part) in patches.enumerated() {
      rows.append(WorkspaceDiffRow(id: "\(section):title", kind: .title, text: part.section.title))
      guard part.kind == .text else {
        let note =
          part.kind == .binary
          ? "Binary file: preview unavailable"
          : part.kind == .tooLarge ? "This patch exceeds the preview limit" : "Diff unavailable for this file"
        rows.append(WorkspaceDiffRow(id: "\(section):note", kind: .note, text: note))
        continue
      }
      var lines = part.text.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
      if lines.last == "" { lines.removeLast() }
      let firstHunk = lines.firstIndex { $0.hasPrefix("@@") } ?? lines.count
      for (index, line) in lines.enumerated() {
        let kind: WorkspaceDiffRow.Kind
        if part.section == .untracked || index < firstHunk {
          kind = .plain
        } else if line.hasPrefix("+") {
          kind = .added
        } else if line.hasPrefix("-") {
          kind = .removed
        } else if line.hasPrefix("@@") {
          kind = .hunk
        } else {
          kind = .context
        }
        rows.append(WorkspaceDiffRow(id: "\(section):\(index)", kind: kind, text: line))
      }
    }
    return rows
  }
}
