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
