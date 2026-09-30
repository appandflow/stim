import Foundation

/// A Claude Code or Codex session working in a workspace, from `stim status --json` `agents`, or one that stopped
/// running there, from `endedAgents`, which alone carries `endedAt`. `openUrl` opens it in the tool's desktop app;
/// status sets it only when that app is installed on this Mac.
public struct AgentSession: Decodable, Hashable, Sendable, Identifiable {
  public var tool: String
  public var sessionId: String
  public var title: String?
  public var cwd: String
  public var startedAt: String?
  public var lastActiveAt: String?
  public var pid: Int?
  public var openUrl: String?
  public var webUrl: String?
  public var endedAt: String?

  public var id: String { "\(tool):\(sessionId)" }

  public var toolName: String {
    switch tool {
    case "claude-code": "Claude Code"
    case "codex": "Codex"
    default: tool
    }
  }

  public var ended: Bool { endedAt != nil }

  /// "Claude Code · Fix the login bug · 5m ago": the tool, the title when there is one and the activity age, or
  /// "ended 5m ago" for an ended session.
  public func label(now: Date = Date()) -> String {
    let age = (endedAt ?? lastActiveAt).flatMap(Self.date).map { ActivityBadge.duration(max(0, now.timeIntervalSince($0))) }
    let when = ended ? (age.map { "ended \($0) ago" } ?? "ended") : age.map { "\($0) ago" }
    return [toolName, title, when].compactMap { $0 }.joined(separator: " \u{00B7} ")
  }

  /// `openUrl` when it is a Claude desktop or Codex app link; any other scheme is ignored.
  public var openURL: URL? {
    guard let text = openUrl, let url = URL(string: text), ["claude", "codex"].contains(url.scheme) else { return nil }
    return url
  }

  public var openHelp: String { "Open this session in \(tool == "codex" ? "Codex" : "Claude")" }

  private static func date(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }
}
